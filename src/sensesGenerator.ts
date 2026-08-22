/*
Keep looping through the following steps until maxItems AI requests have been sent (default 100), then stop:
1. length (default 2) and existingOnly (default false) are parameters.
   If existingOnly is false, walk all letter combinations of that length (e.g. AA–ZZ) in order.
   For each batch of parallelRequests combinations whose loading_status is not "Senses", get_or_create
   the entry (create it if missing) via get_entries_for_senses_generator.
   If existingOnly is true, skip creating letter combinations and query already existing entries of
   that length whose loading_status is not "Senses".
   Return existing senses for the entry as well.
2. Split each entry into its own parallel request:
   a. For each entry, generate a prompt using the senses_prompt.txt file. The item should be the entry's display text but uppercased.
      Send the prompt to the AIProvider (make this a parameter).
   b. Update the database with the info returned from the API.
      - The senses should be updated whether or not they already existed. If the sense is referenced to an existing
        sense, that sense ID should be conserved even as the summary etc. are updated.
   c. Whether the entry already existed or was just created, update the entry's display_text and entry_type
      from the sense that was deemed Primary (display_text and classification). If that Primary sense has a
      base form, also update the entry's base_form.
      If a Word or Phrase sense has Base form, set that sense's classification to Inflected Word or Inflected Phrase.
      Proper Name, Acronym/Abbreviation, and Prefix/Suffix are left unchanged.
      If that sense is Primary, entry_type follows it.
      If the AI returns Nonsense, still update the entry but set entry_type to "Nonsense".
   d. Set the entry's loading_status to "Senses" and reviewed_status to "1".
      Do not update any other fields on the entry table besides display_text, entry_type, base_form,
      loading_status, and reviewed_status.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
Sense summary and definition are stored directly on the sense row. Natural and colloquial translations are stored in sense_entry_translation; alternatives are stored in sense.similar_entries.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  addSenseEntryTranslations,
  getEntriesForSensesGenerator,
  updateEntryFromPrimarySense,
  upsertSense,
  EntryForSensesGenerator,
  ExistingSenseInfo,
} from 'cruzi-db';
import { EntryRef, LanguageNames, Sense } from 'cruzi-models';
import { CursorAiProvider } from './ai/cursor';
import { IAiProvider } from './ai/IAiProvider';
import { displayTextToEntry, generateId, isGeminiTimeoutError } from './lib/utils';

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;
const DEFAULT_LANG = 'en';
const DEFAULT_LENGTH = 2;
const DEFAULT_EXISTING_ONLY = false;

function buildLetterCombinations(length: number): string[] {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (length <= 0) {
    return [];
  }

  const combinations: string[] = [];
  const generate = (prefix: string) => {
    if (prefix.length === length) {
      combinations.push(prefix);
      return;
    }
    for (const letter of letters) {
      generate(prefix + letter);
    }
  };
  generate('');
  return combinations;
}

const cursorProvider = new CursorAiProvider();

async function loadSensesPromptAsync(): Promise<string> {
  try {
    return await fs.promises.readFile('./src/ai/senses_prompt.txt', 'utf-8');
  } catch (err) {
    console.error('Error reading senses prompt file:', err);
    throw err;
  }
}

interface ParsedSense {
  partOfSpeech: string;
  classification: string;
  frequency: string;
  displayText: string;
  summary: string;
  definition: string;
  baseForm?: string;
  naturalTranslations: string[];
  colloquialTranslations: string[];
  alternatives: string[];
  correspondingExistingSense?: string;
}

const LIST_FIELD_PREFIX_REGEX = /^(?:Base form|Natural|Colloquial|Alternatives)\s*:\s*/i;

function splitListField(text: string): string[] {
  const withoutLabel = text.replace(LIST_FIELD_PREFIX_REGEX, '').replace(/^:\s*/, '').trim();
  return withoutLabel
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item !== '' && item.toLowerCase() !== '(none)');
}

const SENSE_HEADER_REGEX =
  /\(([^,\n)]+),\s*([^,\n)]+),\s*(Primary|Common|Uncommon)\)\s+([^\n]+)/g;

const SENSE_FIELD_LABELS = [
  'Base form',
  'Natural',
  'Colloquial',
  'Alternatives',
  'Corresponding existing sense',
] as const;

function extractLabeledField(
  text: string,
  label: string,
  followingLabels: readonly string[],
): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nextLabelPattern = followingLabels
    .map((nextLabel) => nextLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const boundary = nextLabelPattern.length > 0 ? `(?=(?:${nextLabelPattern}):)` : '$';
  const regex = new RegExp(`${escapedLabel}\\s*:\\s*([\\s\\S]*?)${boundary}`);
  const match = text.match(regex);
  return match?.[1]?.trim();
}

function inflectedClassification(classification: string): string | undefined {
  const normalized = classification.trim().toLowerCase();
  if (normalized === 'phrase' || normalized === 'inflected phrase') {
    return 'Inflected Phrase';
  }
  if (normalized === 'word' || normalized === 'inflected word') {
    return 'Inflected Word';
  }
  return undefined;
}

function parseSenseBlock(
  partOfSpeech: string,
  classification: string,
  frequency: string,
  displayText: string,
  blockContent: string,
): ParsedSense | null {
  const fieldStart = blockContent.search(/^(?:Base form|Natural)\s*:/m);
  const headerSection = (fieldStart === -1 ? blockContent : blockContent.slice(0, fieldStart)).trim();
  const colonIndex = headerSection.indexOf(':');
  if (colonIndex === -1) {
    return null;
  }

  const summary = headerSection.slice(0, colonIndex).replace(/\s+/g, ' ').trim();
  const definition = headerSection.slice(colonIndex + 1).replace(/\s+/g, ' ').trim();

  const baseFormText = extractLabeledField(blockContent, 'Base form', SENSE_FIELD_LABELS.slice(1));
  const naturalText = extractLabeledField(blockContent, 'Natural', SENSE_FIELD_LABELS.slice(2));
  const colloquialText = extractLabeledField(blockContent, 'Colloquial', SENSE_FIELD_LABELS.slice(3));
  const alternativesText = extractLabeledField(
    blockContent,
    'Alternatives',
    SENSE_FIELD_LABELS.slice(4),
  );
  const correspondingText = extractLabeledField(
    blockContent,
    'Corresponding existing sense',
    [],
  );

  if (!summary || !definition || naturalText === undefined || colloquialText === undefined || alternativesText === undefined) {
    return null;
  }

  const baseForm = baseFormText ? splitListField(baseFormText)[0] : undefined;
  const isInflectedForm = Boolean(baseForm);
  const resolvedClassification =
    (isInflectedForm ? inflectedClassification(classification) : undefined) ?? classification.trim();

  return {
    partOfSpeech: partOfSpeech.trim(),
    classification: resolvedClassification,
    frequency: frequency.trim(),
    displayText: displayText.trim(),
    summary,
    definition,
    ...(baseForm ? { baseForm } : {}),
    naturalTranslations: splitListField(naturalText),
    colloquialTranslations: splitListField(colloquialText),
    alternatives: splitListField(alternativesText),
    ...(correspondingText !== undefined ? { correspondingExistingSense: correspondingText } : {}),
  };
}

function parseSensesResponse(response: string): ParsedSense[] {
  const senses: ParsedSense[] = [];
  const normalized = response.replace(/```(?:\w+)?/g, '').trim();
  const headers: RegExpExecArray[] = [];

  let headerMatch: RegExpExecArray | null;
  const headerRegex = new RegExp(SENSE_HEADER_REGEX.source, 'g');
  while ((headerMatch = headerRegex.exec(normalized)) !== null) {
    headers.push(headerMatch);
  }

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const blockStart = header.index! + header[0].length;
    const blockEnd = i + 1 < headers.length ? headers[i + 1].index! : normalized.length;
    const blockContent = normalized.slice(blockStart, blockEnd).trim();

    const parsed = parseSenseBlock(
      header[1],
      header[2],
      header[3],
      header[4],
      blockContent,
    );
    if (parsed) {
      senses.push(parsed);
    }
  }

  return senses;
}

function resolveSenseId(
  parsedSense: ParsedSense,
  existingSenses: ExistingSenseInfo[],
): string {
  if (
    parsedSense.correspondingExistingSense &&
    parsedSense.correspondingExistingSense.toLowerCase() !== 'none'
  ) {
    const existing = existingSenses.find(
      (info) => info.summary === parsedSense.correspondingExistingSense,
    );
    if (existing) {
      return existing.id;
    }
  }
  return generateId();
}

function removeParenthesizedComments(text: string): string {
  return text.replace(/\([^)]*\)/g, '').trim();
}

function createSenseFromParsedData(
  parsedSense: ParsedSense,
  entry: string,
  lang: string,
  existingSenses: ExistingSenseInfo[],
  translationLang: string,
  sourceAi: string,
): Sense {
  const senseId = resolveSenseId(parsedSense, existingSenses);

  const toEntryRef = (text: string): EntryRef => {
    const cleaned = removeParenthesizedComments(text);
    return {
      entry: displayTextToEntry(cleaned),
      lang: translationLang,
      displayText: cleaned,
    };
  };

  return {
    id: senseId,
    entry: {
      entry,
      lang,
    },
    displayText: parsedSense.displayText,
    baseForm: parsedSense.baseForm,
    partOfSpeech: parsedSense.partOfSpeech,
    classification: parsedSense.classification,
    frequency: parsedSense.frequency,
    summary: parsedSense.summary,
    definition: parsedSense.definition,
    similarEntries: parsedSense.alternatives
      .map(removeParenthesizedComments)
      .filter((alternative) => alternative !== ''),
    translations: {
      [translationLang]: {
        naturalTranslations: parsedSense.naturalTranslations.map(toEntryRef),
        colloquialTranslations: parsedSense.colloquialTranslations.map(toEntryRef),
        sourceAi,
      },
    },
    sourceAi,
  };
}

function buildSensesPrompt(
  promptTemplate: string,
  item: EntryForSensesGenerator,
): string {
  const translationLang = item.lang === 'en' ? 'es' : 'en';
  const referenceSenses =
    item.existingSenses.length > 0
      ? item.existingSenses.map((info) => info.summary).join('\n')
      : '(None)';

  return promptTemplate
    .replace('[[PHRASE]]', item.displayText.toUpperCase())
    .replace('[[SOURCE_LANGUAGE]]', LanguageNames[item.lang] ?? item.lang)
    .replace('[[TRANSLATION_LANGUAGE]]', LanguageNames[translationLang] ?? translationLang)
    .replace('[[REFERENCE SENSES]]', referenceSenses);
}

async function processEntry(
  promptTemplate: string,
  item: EntryForSensesGenerator,
  provider: IAiProvider,
  requestLabel: string,
): Promise<boolean> {
  console.log(
    `${requestLabel}: processing ${item.entry} (${item.lang}) "${item.displayText}" ` +
      `- ${item.existingSenses.length} existing senses`,
  );

  const prompt = buildSensesPrompt(promptTemplate, item);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: AI response for ${item.entry}:`, aiResponse);

  if (aiResponse.trim().toLowerCase() === 'nonsense') {
    await updateEntryFromPrimarySense(item.entry, item.lang, '', 'Nonsense');
    console.log(
      `${requestLabel}: set ${item.entry} entry_type=Nonsense, loading_status=Senses, reviewed_status=1`,
    );
    return true;
  }

  const parsedSenses = parseSensesResponse(aiResponse);
  console.log(`${requestLabel}: parsed ${parsedSenses.length} senses for ${item.entry}`);

  if (parsedSenses.length === 0) {
    console.warn(`${requestLabel}: skipping ${item.entry} (no senses parsed)`);
    return false;
  }

  const translationLang = item.lang === 'en' ? 'es' : 'en';
  const senses: Sense[] = parsedSenses.map((parsedSense) =>
    createSenseFromParsedData(
      parsedSense,
      item.entry,
      item.lang,
      item.existingSenses,
      translationLang,
      provider.sourceAI,
    ),
  );

  for (const sense of senses) {
    const { translations, ...senseWithoutTranslations } = sense;
    await upsertSense(item.entry, item.lang, senseWithoutTranslations);

    const translationRows = Object.entries(translations ?? {}).map(
      ([translationLang, translation]) => ({
        sense_id: sense.id!,
        entry: item.entry,
        lang: translationLang,
        natural_translations: (translation.naturalTranslations ?? []).map(
          (t) => t.displayText ?? t.entry,
        ),
        colloquial_translations: (translation.colloquialTranslations ?? []).map(
          (t) => t.displayText ?? t.entry,
        ),
      }),
    );
    await addSenseEntryTranslations(translationRows);
  }
  console.log(`${requestLabel}: updated ${senses.length} senses in database for ${item.entry}`);

  const primarySense = senses.find((sense) => sense.frequency === 'Primary');
  if (primarySense?.id) {
    await updateEntryFromPrimarySense(
      item.entry,
      item.lang,
      primarySense.displayText ?? item.displayText,
      primarySense.classification ?? '',
      primarySense.baseForm,
    );
    console.log(
      `${requestLabel}: updated entry ${item.entry} display_text="${primarySense.displayText ?? item.displayText}" ` +
        `entry_type="${primarySense.classification ?? ''}"` +
        `${primarySense.baseForm ? `, base_form="${primarySense.baseForm}"` : ''}` +
        `, loading_status=Senses, reviewed_status=1`,
    );
  } else {
    await updateEntryFromPrimarySense(item.entry, item.lang, '', '');
    console.warn(
      `${requestLabel}: no Primary sense for ${item.entry}; set loading_status=Senses, reviewed_status=1 without changing display_text or entry_type`,
    );
  }

  return true;
}

export async function sensesGenerator(
  provider: IAiProvider = cursorProvider,
  maxItems: number = DEFAULT_MAX_ITEMS,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
  lang: string = DEFAULT_LANG,
  length: number = DEFAULT_LENGTH,
  existingOnly: boolean = DEFAULT_EXISTING_ONLY,
): Promise<void> {
  try {
    const concurrency = Math.max(1, parallelRequests);
    const entryLength = Math.max(1, length);
    const combos = existingOnly ? [] : buildLetterCombinations(entryLength);
    const comboRangeLabel = existingOnly
      ? `existing ${entryLength}-letter entries`
      : `${combos[0] ?? ''}–${combos[combos.length - 1] ?? ''} (${entryLength}-letter)`;

    console.log(
      `Starting senses generation with provider ${provider.sourceAI} ` +
        `(max ${maxItems} AI requests, ${concurrency} parallel, lang=${lang}, ${comboRangeLabel})...`,
    );

    const promptTemplate = await loadSensesPromptAsync();
    let itemsCompleted = 0;
    let cycleNumber = 0;
    let shouldStop = false;

    while (itemsCompleted < maxItems && !shouldStop) {
      const remainingItems = maxItems - itemsCompleted;
      const requestsThisCycle = Math.min(concurrency, remainingItems);

      const entries = await getEntriesForSensesGenerator(
        lang,
        entryLength,
        requestsThisCycle,
        existingOnly,
        combos,
      );
      if (entries.length === 0) {
        console.log(
          existingOnly
            ? `No existing ${entryLength}-letter entries remaining for senses generation`
            : `No ${entryLength}-letter combinations remaining for senses generation`,
        );
        break;
      }

      cycleNumber++;
      console.log(
        `Cycle ${cycleNumber}: ${entries.length} parallel AI requests; ` +
          `${itemsCompleted}/${maxItems} requests completed so far`,
      );

      let cycleHadTimeout = false;
      const persistedFlags = await Promise.all(
        entries.map(async (item, index) => {
          const itemNumber = itemsCompleted + index + 1;
          const requestLabel = `Request ${itemNumber}/${maxItems}`;

          try {
            return await processEntry(promptTemplate, item, provider, requestLabel);
          } catch (error) {
            if (isGeminiTimeoutError(error)) {
              cycleHadTimeout = true;
              console.warn(
                `${requestLabel}: AI request took more than 5 minutes; abandoning and continuing`,
              );
              return false;
            }

            console.error(`${requestLabel}: error processing ${item.entry}:`, error);
            shouldStop = true;
            return false;
          }
        }),
      );

      itemsCompleted += entries.length;

      if (!shouldStop && !cycleHadTimeout && persistedFlags.every((persisted) => !persisted)) {
        console.warn(`No entries persisted in cycle ${cycleNumber}; stopping`);
        break;
      }
    }

    if (itemsCompleted >= maxItems) {
      console.log(`Reached max AI request limit of ${maxItems}; stopping`);
    } else {
      console.log(`Stopped after ${itemsCompleted} AI requests`);
    }
  } catch (error) {
    console.error('Fatal error in sensesGenerator:', error);
    throw error;
  }
}
