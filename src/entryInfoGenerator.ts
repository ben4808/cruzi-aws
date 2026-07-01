/**
Loop through the following tasks until the queue is empty:
1. Query the database for the top entry in the entry_info_queue table.
  - Response will be in the following JSON structure:
  [
    {
      entry: string,
      display_text: string,
      lang: string,
      existing_sense_info: [{
        id: string,
        summary: string
      }],
      example_sentence_count: number,
    },
    ...
  ]
2. Using the prompt in senses_prompt.txt, send a request to Gemini (using the geminiWebProvider non-extended) to generate senses for the entry.
  - Include the summaries of the existing senses as the REFERENCE_SENSES, one per line.
3. Update the database with the info returned from the API.
  - The senses should be updated whether or not they already existed. If the sense is referenced to an existing
    sense, that sense ID should be conserved even as the summary etc. are updated.
4. For any returned senses, existing or new, that have less than 3 example sentences, add the sense to the example_sentence_queue table.
5. Query for any clues in the database with the specified entry and no sense_id or custom_clue. Assign these clues the sense_id that was determined as Primary.
  - Use the DAO function assign_primary_sense_to_clues(entry: string, lang: string, primary_sense_id: string)
6. Remove the entry from the queue after being successfully processed.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed. Sense summary and definition are stored directly on the sense row. Natural and colloquial translations are stored in sense_entry_translation; alternatives are stored in sense.similar_entries.
cruzi-db/sql/schema.sql is the source of truth for the database schema. 
Keep these requirements in the file.
 */

import fs from 'fs';
import {
  getEntryInfoQueueTop1,
  upsertSense,
  addExampleSentenceQueueEntries,
  assignPrimarySenseToClues,
  getSensesForEntry,
  removeFromEntryInfoQueue,
  EntryInfoQueueItem,
  ExistingSenseInfo,
} from 'cruzi-db';
import { EntryRef, LanguageNames, Sense } from 'cruzi-models';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { isGeminiTimeoutError } from './lib/utils';
import { displayTextToEntry, generateId } from './lib/utils';

const geminiProvider = new GeminiWebAiProvider();

async function loadSensesPromptAsync(): Promise<string> {
  try {
    const content: string = await fs.promises.readFile('./src/ai/senses_prompt.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading senses prompt file:', err);
    throw err;
  }
}

interface ParsedSense {
  partOfSpeech: string;
  classification: string;
  frequency: string;
  summary: string;
  definition: string;
  naturalTranslations: string[];
  colloquialTranslations: string[];
  alternatives: string[];
  correspondingExistingSense?: string;
}

const TRANSLATION_FIELD_PREFIX_REGEX = /^(?:Natural|Colloquial|Alternatives)\s*:\s*/i;

function splitTranslationList(text: string): string[] {
  const withoutLabel = text.replace(TRANSLATION_FIELD_PREFIX_REGEX, '').replace(/^:\s*/, '').trim();
  return withoutLabel.split(';').map((t) => t.trim()).filter((t) => t !== '' && t.toLowerCase() !== '(none)');
}

// Header includes short description and colon so "(None)" / in-definition "(Noun, Word, Primary)" cannot false-match.
const SENSE_HEADER_REGEX =
  /\(([^,\n)]+),\s*([^,\n)]+),\s*(Primary|Common|Uncommon)\)\s+([^:\n]+?)\s*:\s*/g;

const SENSE_FIELD_LABELS = [
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

function parseSenseBlock(
  partOfSpeech: string,
  classification: string,
  frequency: string,
  summary: string,
  blockContent: string,
): ParsedSense | null {
  const naturalIndex = blockContent.search(/Natural:/);
  const definition = (naturalIndex === -1 ? blockContent : blockContent.slice(0, naturalIndex))
    .replace(/\s+/g, ' ')
    .trim();

  const naturalText = extractLabeledField(blockContent, 'Natural', SENSE_FIELD_LABELS.slice(1));
  const colloquialText = extractLabeledField(blockContent, 'Colloquial', SENSE_FIELD_LABELS.slice(2));
  const alternativesText = extractLabeledField(
    blockContent,
    'Alternatives',
    SENSE_FIELD_LABELS.slice(3),
  );
  const correspondingText = extractLabeledField(
    blockContent,
    'Corresponding existing sense',
    [],
  );

  if (
    !summary ||
    !definition ||
    naturalText === undefined ||
    colloquialText === undefined ||
    alternativesText === undefined
  ) {
    return null;
  }

  return {
    partOfSpeech: partOfSpeech.trim(),
    classification: classification.trim(),
    frequency: frequency.trim(),
    summary: summary.trim(),
    definition,
    naturalTranslations: splitTranslationList(naturalText),
    colloquialTranslations: splitTranslationList(colloquialText),
    alternatives: splitTranslationList(alternativesText),
    ...(correspondingText !== undefined ? { correspondingExistingSense: correspondingText } : {}),
  };
}

function parseSensesResponse(response: string): ParsedSense[] {
  const senses: ParsedSense[] = [];
  const normalized = response.trim();
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
  existingSenseInfo: ExistingSenseInfo[],
): string {
  if (
    parsedSense.correspondingExistingSense &&
    parsedSense.correspondingExistingSense.toLowerCase() !== 'none'
  ) {
    const existing = existingSenseInfo.find(
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
  existingSenseInfo: ExistingSenseInfo[],
  translationLang: string,
): Sense {
  const senseId = resolveSenseId(parsedSense, existingSenseInfo);

  const toEntryRef = (text: string): EntryRef => {
    const cleaned = removeParenthesizedComments(text);
    return {
      entry: displayTextToEntry(cleaned),
      lang: translationLang,
      displayText: cleaned,
    };
  };

  const sense: Sense = {
    id: senseId,
    entry: {
      entry,
      lang,
    },
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
        sourceAi: 'gemini',
      },
    },
    sourceAi: 'gemini',
  };

  if (
    parsedSense.correspondingExistingSense &&
    parsedSense.correspondingExistingSense.toLowerCase() !== 'none'
  ) {
    (sense as Sense & { corresponds_with?: string }).corresponds_with =
      parsedSense.correspondingExistingSense;
  }

  return sense;
}

function buildSensesPrompt(
  promptTemplate: string,
  item: EntryInfoQueueItem,
): string {
  const translationLang = item.lang === 'en' ? 'es' : 'en';
  const referenceSenses =
    item.existing_sense_info.length > 0
      ? item.existing_sense_info.map((info) => info.summary).join('\n')
      : '(None)';

  return promptTemplate
    .replace('[[PHRASE]]', item.display_text)
    .replace('[[SOURCE_LANGUAGE]]', LanguageNames[item.lang] ?? item.lang)
    .replace('[[TRANSLATION_LANGUAGE]]', LanguageNames[translationLang] ?? translationLang)
    .replace('[[REFERENCE SENSES]]', referenceSenses);
}

function countExampleSentences(sense: Sense): number {
  if (!Array.isArray(sense.exampleSentences)) {
    return 0;
  }

  const exampleIds = new Set(
    sense.exampleSentences
      .map((example: { id?: string }) => example.id)
      .filter((id): id is string => !!id),
  );
  return exampleIds.size;
}

async function saveSenses(entry: string, lang: string, senses: Sense[]): Promise<void> {
  for (const sense of senses) {
    await upsertSense(entry, lang, sense);
  }
}

async function processQueueItem(
  promptTemplate: string,
  item: EntryInfoQueueItem,
): Promise<void> {
  console.log(
    `Processing entry: ${item.entry} (${item.lang}) - ${item.existing_sense_info.length} existing senses`,
  );

  const prompt = buildSensesPrompt(promptTemplate, item);
  const aiResponse = await geminiProvider.generateResultsAsync(prompt);
  console.log(`AI response for ${item.entry}:`, aiResponse);

  if (aiResponse.trim().toLowerCase() === 'nonsense') {
    console.log(`Skipping ${item.entry} (Nonsense response)`);
    return;
  }

  const parsedSenses = parseSensesResponse(aiResponse);
  console.log(`Parsed ${parsedSenses.length} senses for ${item.entry}`);

  if (parsedSenses.length === 0) {
    console.log(`Skipping ${item.entry} (no senses parsed)`);
    return;
  }

  const translationLang = item.lang === 'en' ? 'es' : 'en';
  const senses: Sense[] = parsedSenses.map((parsedSense) =>
    createSenseFromParsedData(
      parsedSense,
      item.entry,
      item.lang,
      item.existing_sense_info,
      translationLang,
    ),
  );

  await saveSenses(item.entry, item.lang, senses);
  console.log(`Updated senses in database for ${item.entry}`);

  const primarySense = senses.find((sense) => sense.frequency === 'Primary');
  if (primarySense?.id) {
    await assignPrimarySenseToClues(item.entry, item.lang, primarySense.id);
    console.log(`Assigned primary sense ${primarySense.id} to clues for ${item.entry}`);
  }

  const dbSenses = await getSensesForEntry(item.entry, item.lang);
  const sensesToQueue = dbSenses
    .filter((sense) => countExampleSentences(sense) < 3)
    .map((sense) => sense.id)
    .filter((id): id is string => !!id);

  if (sensesToQueue.length > 0) {
    await addExampleSentenceQueueEntries(sensesToQueue);
    console.log(`Queued ${sensesToQueue.length} senses for example sentences`);
  }
}

export async function entryInfoGenerator(): Promise<void> {
  try {
    console.log('Starting entry info generation...');

    const promptTemplate = await loadSensesPromptAsync();
    let itemNumber = 0;

    while (true) {
      const queueItem = await getEntryInfoQueueTop1();
      if (!queueItem) {
        console.log('No entries in queue');
        break;
      }

      itemNumber++;
      console.log(`Processing entry info item ${itemNumber}: ${queueItem.entry} (${queueItem.lang})`);

      try {
        await processQueueItem(promptTemplate, queueItem);

        await removeFromEntryInfoQueue(queueItem.entry, queueItem.lang);
        console.log(`Removed ${queueItem.entry} (${queueItem.lang}) from entry info queue`);
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing ${queueItem.entry}`);
          break;
        }

        console.error(`Error processing entry ${queueItem.entry}:`, error);

        try {
          await removeFromEntryInfoQueue(queueItem.entry, queueItem.lang);
          console.log(`Removed ${queueItem.entry} from entry info queue after error`);
        } catch (dbError) {
          console.error(`Failed to remove ${queueItem.entry} from entry info queue:`, dbError);
        }
      }
    }
  } catch (error) {
    console.error('Fatal error in entryInfoGenerator:', error);
    throw error;
  }
}

