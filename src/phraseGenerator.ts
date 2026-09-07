/*
Keep looping through the following steps until maxItems queue items have been processed (default 100), then stop:
1. Select enough queue items for parallelRequests concurrent executions via get_phrase_generator_queue
   (ordered by added_at).
2. For each selected queue item (up to parallelRequests in parallel):
   a. Select all rows from the entry table that match the prompt from the queue item. Only select entries
      that have a space between the base word and the blank. For example, for "snow ____", "show day" 
      would be selected, but "snowman" would not.
   b. If there are more than 200 existing entries that match the prompt, delete the queue item and move
      on to the next. It starts to get unwieldy otherwise.
   c. Using phrase_generator_prompt_2.txt as a prompt, populate the [[QUERY]], [[BASE]], and [[START/END]] placeholders.
      Populate the banned list with the display_text from the results from step a.
      Send the prompt to the AIProvider (make this a parameter).
   d. After "All Full Words/Phrases Utilized:" in the response will be a list of phrases with related phrases separated by a colon.
   e. Run the phrases through entry_parser_prompt_3.txt as entryParser does: display_text, entry_type, base_form, is_vulgar,
      secondary classes (when secondary_display differs from primary), and the display-key match check (Failed parse).
   f. Run successful parses through unity_prompt_3.txt as unityGenerator does (primary + secondaries, promote a good secondary
      when the primary is Partial/Variant/Non-unit/Nonsense, delete Non-unit/Nonsense secondaries, keep Partial/Variant secondaries).
   g. Run remaining items through familiarity_prompt_3.txt as familiarityGenerator does (include class and unity bucket, secondaries
      with their own class/unity, Obscure→Partial/Niche inference via get_partial_phrase_items, delete Obscure/Barely Exists/Nonsense
      secondaries, promote the highest-familiarity class). Skip Nonsense entry_type/unity_bucket.
   h. For each phrase from step d, insert a phrase_generator_result row with all fields (base_form, is_vulgar, entry_type,
      display_text, unity_bucket, familiarity_bucket). Persist remaining secondaries to entry_secondary_class for keys that are
      not already in entry (same table/keys as entry).
   i. Insert vetted phrases into the entry table (not Nonsense type; unity not Partial/Variant/Non-unit/Nonsense; familiarity not
      Obscure/Barely Exists/Nonsense; not Failed parse), including display_text, entry_type, base_form, is_vulgar, unity
      bucket/score, familiarity bucket/score, and reviewed_status "123". Do not overwrite existing entry fields with non-null
      values; only insert new rows or populate null fields on existing rows. For entries that were not already in the entry table,
      insert an entry_tag record with the tag "phrase_generator".
   j. Delete the queue item from the phrase_generator_queue table.
   k. Count the number of phrases that were inserted into the entry table that actually match the prompt of the original queue item.
      If it is 5 or more, reinsert the original queue item into the phrase_generator_queue table.
3. maxItems is the total number of queue items to process before quitting (not the number of DB cycles).

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed. Use insertEntriesOrFillNulls for entry persistence.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  addEntryTags,
  addPhraseGeneratorQueueEntries,
  addPhraseGeneratorResults,
  deletePhraseGeneratorQueueItem,
  EntryForFamiliarityGenerator,
  EntryForUnityGenerator,
  getEntries,
  getEntriesByBaseWord,
  getPhraseGeneratorQueue,
  insertEntriesOrFillNulls,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { IAiProvider } from './ai/IAiProvider';
import {
  parseEntriesWithEntryParser3Full,
  scorePhrasesForFamiliarityBucket,
  scorePhrasesForUnityBucket,
} from './ai/phraseScoring';
import { buildResultsToPersist as buildEntryParserResultsToPersist } from './entryParser';
import {
  applyPartialPhraseInference,
  buildResultsToPersist as buildFamiliarityGeneratorResultsToPersist,
  collectPromptPhrases as collectFamiliarityPromptPhrases,
} from './familiarityGenerator';
import { entryToAllCaps, batchArray, isGeminiTimeoutError, stripAccents } from './lib/utils';
import {
  buildResultsToPersist as buildUnityGeneratorResultsToPersist,
  collectPromptPhrases as collectUnityPromptPhrases,
  UNITY_SCORES,
} from './unityGenerator';

const REQUEUE_THRESHOLD = 5;
const MATCH_SKIP_THRESHOLD = 200;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;
const ENTRIES_PER_REQUEST = 100;
const BLANK_PLACEHOLDER = '____';
const REVIEWED_STATUS_AFTER_FAMILIARITY = '123';
const REJECTED_UNITY_BUCKETS = new Set(['Variant', 'Non-unit', 'Nonsense']);
const REJECTED_FAMILIARITY_BUCKETS = new Set(['Obscure', 'Barely Exists', 'Nonsense']);

interface PipelineSecondary {
  secondaryClass: string;
  secondaryDisplay: string;
  secondaryBaseForm?: string;
  unityBucket?: string;
  familiarityBucket?: string;
}

interface PipelineItem {
  entryKey: string;
  lang: string;
  displayText: string;
  entryType?: string;
  baseForm?: string;
  isVulgar?: boolean;
  parseFailed: boolean;
  secondaries: PipelineSecondary[];
  unityBucket?: string;
  unityScore?: number;
  familiarityBucket?: string;
  familiarityScore?: number;
}

export interface ParsedQueuePrompt {
  query: string;
  base: string;
  position: 'start' | 'end';
}

async function loadPhraseGeneratorPromptAsync(): Promise<string> {
  try {
    return await fs.promises.readFile('./src/ai/phrase_generator_prompt_2.txt', 'utf-8');
  } catch (err) {
    console.error('Error reading phrase generator prompt file:', err);
    throw err;
  }
}

export function formatDisplayQuery(parsedPrompt: ParsedQueuePrompt): string {
  const displayBase = parsedPrompt.base.toLowerCase();

  if (parsedPrompt.position === 'start') {
    return `${displayBase} ${BLANK_PLACEHOLDER}`;
  }

  return `${BLANK_PLACEHOLDER} ${displayBase}`;
}

export function parseQueuePrompt(prompt: string): ParsedQueuePrompt {
  const trimmed = prompt.trim();

  if (trimmed.startsWith(`${BLANK_PLACEHOLDER} `)) {
    const base = trimmed.slice(BLANK_PLACEHOLDER.length).trim();
    return { query: trimmed, base, position: 'end' };
  }

  if (trimmed.endsWith(` ${BLANK_PLACEHOLDER}`)) {
    const base = trimmed.slice(0, trimmed.length - BLANK_PLACEHOLDER.length).trim();
    return { query: trimmed, base, position: 'start' };
  }

  throw new Error(`Unrecognized phrase generator prompt format: ${prompt}`);
}

export function buildPhraseGeneratorPrompt(
  template: string,
  parsedPrompt: ParsedQueuePrompt,
  bannedPhrases: string[],
): string {
  const bannedList = bannedPhrases.length > 0 ? bannedPhrases.join('\n') : '(none)';
  const displayQuery = formatDisplayQuery(parsedPrompt);
  const displayBase = parsedPrompt.base.toLowerCase();

  return template
    .replace('[[QUERY]]', displayQuery)
    .replace('[[BASE]]', displayBase)
    .replace('[[START/END]]', parsedPrompt.position)
    .replace('(none)', bannedList);
}

export function parsePhraseGeneratorResponse(response: string): string[] {
  const marker = 'All Full Words/Phrases Utilized:';
  const markerIndex = response.indexOf(marker);
  if (markerIndex === -1) {
    return [];
  }

  const summaryText = response.slice(markerIndex + marker.length);
  const lines = summaryText.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const phrases: string[] = [];

  for (const line of lines) {
    const separatorIndex = line.indexOf(' : ');
    if (separatorIndex === -1) {
      phrases.push(line);
      continue;
    }

    const primary = line.slice(0, separatorIndex).trim();
    const supplemental = line.slice(separatorIndex + 3).trim();

    if (primary) {
      phrases.push(primary);
    }
    if (supplemental) {
      phrases.push(supplemental);
    }
  }

  return [...new Set(phrases)];
}

export function phraseMatchesPosition(
  displayText: string,
  base: string,
  position: 'start' | 'end',
): boolean {
  const normalizedPhrase = stripAccents(displayText).toLowerCase();
  const normalizedBase = stripAccents(base).toLowerCase();

  if (position === 'start') {
    return normalizedPhrase.startsWith(`${normalizedBase} `);
  }

  return normalizedPhrase.endsWith(` ${normalizedBase}`);
}

function isVettablePipelineItem(item: PipelineItem): boolean {
  return (
    !item.parseFailed &&
    !!item.displayText &&
    !!item.entryType &&
    item.entryType !== 'Nonsense' &&
    !!item.unityBucket &&
    !REJECTED_UNITY_BUCKETS.has(item.unityBucket) &&
    item.unityScore != null &&
    !!item.familiarityBucket &&
    !REJECTED_FAMILIARITY_BUCKETS.has(item.familiarityBucket) &&
    item.familiarityScore != null
  );
}

async function parsePhrasesForPipeline(
  items: PipelineItem[],
  provider: IAiProvider,
): Promise<void> {
  const entryKeys = items.map((item) => item.entryKey);
  const parsedResults = [];
  for (const chunk of batchArray(entryKeys, ENTRIES_PER_REQUEST)) {
    parsedResults.push(...await parseEntriesWithEntryParser3Full(chunk, provider));
  }

  const parserInputs = items.map((item) => ({ entry: item.entryKey, lang: item.lang }));
  const parserResults = buildEntryParserResultsToPersist(parserInputs, parsedResults);
  const parserByEntry = new Map(parserResults.map((result) => [`${result.entry}\0${result.lang}`, result]));

  for (const item of items) {
    const parsed = parserByEntry.get(`${item.entryKey}\0${item.lang}`);
    if (!parsed) {
      continue;
    }

    item.parseFailed = parsed.reviewedStatus === 'Failed parse';
    item.displayText = parsed.displayText || item.displayText;
    item.entryType = parsed.entryType;
    item.baseForm = parsed.baseForm;
    item.isVulgar = parsed.isVulgar;
    item.secondaries = (parsed.secondaryClasses ?? []).map((secondary) => ({
      secondaryClass: secondary.secondaryClass,
      secondaryDisplay: secondary.secondaryDisplay,
      secondaryBaseForm: secondary.secondaryBaseForm,
    }));
  }
}

function applyUnityResultToItem(
  item: PipelineItem,
  result: ReturnType<typeof buildUnityGeneratorResultsToPersist>[number],
): void {
  item.unityBucket = result.unityBucket;
  item.unityScore = result.unityScore;
  if (result.displayText) {
    const promoted = item.secondaries.find(
      (secondary) =>
        secondary.secondaryClass === result.entryType &&
        secondary.secondaryDisplay === result.displayText,
    );
    item.displayText = result.displayText;
    if (result.entryType) {
      item.entryType = result.entryType;
    }
    if (promoted) {
      item.baseForm = promoted.secondaryBaseForm;
    }
  }

  const deleted = new Set(result.secondaryClassesToDelete ?? []);
  const unityByClass = new Map(
    (result.secondaryClassesToUpdate ?? []).map((secondary) => [
      secondary.secondaryClass,
      secondary.unityBucket,
    ]),
  );
  item.secondaries = item.secondaries
    .filter((secondary) => !deleted.has(secondary.secondaryClass))
    .map((secondary) => ({
      ...secondary,
      unityBucket: unityByClass.get(secondary.secondaryClass) ?? secondary.unityBucket,
    }));
}

async function scoreUnityForPipeline(
  items: PipelineItem[],
  provider: IAiProvider,
): Promise<void> {
  const eligible = items.filter(
    (item) =>
      !item.parseFailed &&
      item.entryType !== 'Nonsense' &&
      item.displayText.trim() !== '',
  );
  if (eligible.length === 0) {
    return;
  }

  for (const chunk of batchArray(eligible, ENTRIES_PER_REQUEST)) {
    const unityInputs: EntryForUnityGenerator[] = chunk.map((item) => ({
      entry: item.entryKey,
      lang: item.lang,
      displayText: item.displayText,
      entryType: item.entryType ?? null,
      secondaryClasses: item.secondaries.map((secondary) => ({
        secondaryClass: secondary.secondaryClass,
        secondaryDisplay: secondary.secondaryDisplay,
        secondaryBaseForm: secondary.secondaryBaseForm,
      })),
    }));
    const phrases = collectUnityPromptPhrases(unityInputs);
    const resultsByPhrase = await scorePhrasesForUnityBucket(phrases, provider, {
      promptVersion: 3,
    });
    const persistResults = buildUnityGeneratorResultsToPersist(unityInputs, resultsByPhrase);
    const persistByKey = new Map(
      persistResults.map((result) => [`${result.entry}\0${result.lang}`, result]),
    );

    for (const item of chunk) {
      const result = persistByKey.get(`${item.entryKey}\0${item.lang}`);
      if (result) {
        applyUnityResultToItem(item, result);
      }
    }
  }
}

function applyFamiliarityResultToItem(
  item: PipelineItem,
  result: ReturnType<typeof buildFamiliarityGeneratorResultsToPersist>[number],
): void {
  item.familiarityBucket = result.familiarityBucket;
  item.familiarityScore = result.familiarityScore;
  if (result.unityBucket) {
    item.unityBucket = result.unityBucket;
  }
  if (result.unityScore != null) {
    item.unityScore = result.unityScore;
  } else if (item.unityBucket) {
    item.unityScore = UNITY_SCORES[item.unityBucket] ?? item.unityScore;
  }
  if (result.displayText) {
    item.displayText = result.displayText;
  }
  if (result.entryType) {
    item.entryType = result.entryType;
  }
  if (result.displayText) {
    item.baseForm = result.baseForm;
  }

  const deleted = new Set(result.secondaryClassesToDelete ?? []);
  const updates = new Map(
    (result.secondaryClassesToUpdate ?? []).map((secondary) => [
      secondary.secondaryClass,
      secondary,
    ]),
  );
  item.secondaries = item.secondaries
    .filter((secondary) => !deleted.has(secondary.secondaryClass))
    .map((secondary) => {
      const update = updates.get(secondary.secondaryClass);
      return {
        ...secondary,
        familiarityBucket: update?.familiarityBucket ?? secondary.familiarityBucket,
        unityBucket: update?.unityBucket ?? secondary.unityBucket,
      };
    });

  for (const inserted of result.secondaryClassesToInsert ?? []) {
    if (!inserted.secondaryClass || !inserted.secondaryDisplay) {
      continue;
    }
    if (item.secondaries.some((secondary) => secondary.secondaryClass === inserted.secondaryClass)) {
      continue;
    }
    item.secondaries.push({
      secondaryClass: inserted.secondaryClass,
      secondaryDisplay: inserted.secondaryDisplay,
      secondaryBaseForm: inserted.secondaryBaseForm,
      familiarityBucket: inserted.familiarityBucket,
      unityBucket: inserted.unityBucket,
    });
  }
}

async function scoreFamiliarityForPipeline(
  items: PipelineItem[],
  provider: IAiProvider,
): Promise<void> {
  const eligible = items.filter(
    (item) =>
      !item.parseFailed &&
      item.entryType !== 'Nonsense' &&
      item.unityBucket !== 'Nonsense' &&
      item.displayText.trim() !== '' &&
      !!item.unityBucket,
  );
  if (eligible.length === 0) {
    return;
  }

  for (const chunk of batchArray(eligible, ENTRIES_PER_REQUEST)) {
    const familiarityInputs: EntryForFamiliarityGenerator[] = chunk.map((item) => ({
      entry: item.entryKey,
      lang: item.lang,
      displayText: item.displayText,
      entryType: item.entryType ?? null,
      baseForm: item.baseForm,
      unityBucket: item.unityBucket ?? null,
      secondaryClasses: item.secondaries.map((secondary) => ({
        secondaryClass: secondary.secondaryClass,
        secondaryDisplay: secondary.secondaryDisplay,
        secondaryBaseForm: secondary.secondaryBaseForm,
        unityBucket: secondary.unityBucket,
      })),
    }));
    const phrases = collectFamiliarityPromptPhrases(familiarityInputs);
    const resultsByPhrase = await scorePhrasesForFamiliarityBucket(phrases, provider);
    await applyPartialPhraseInference(familiarityInputs, resultsByPhrase);
    const persistResults = buildFamiliarityGeneratorResultsToPersist(
      familiarityInputs,
      resultsByPhrase,
    );
    const persistByKey = new Map(
      persistResults.map((result) => [`${result.entry}\0${result.lang}`, result]),
    );

    for (const item of chunk) {
      const result = persistByKey.get(`${item.entryKey}\0${item.lang}`);
      if (result) {
        applyFamiliarityResultToItem(item, result);
      }
    }
  }
}

async function reviewGeneratedPhrases(
  phrases: string[],
  lang: string,
  provider: IAiProvider,
): Promise<Map<string, PipelineItem>> {
  const itemsByKey = new Map<string, PipelineItem>();
  for (const phrase of phrases) {
    const entryKey = entryToAllCaps(phrase);
    if (!entryKey || itemsByKey.has(entryKey)) {
      continue;
    }
    itemsByKey.set(entryKey, {
      entryKey,
      lang,
      displayText: phrase,
      parseFailed: false,
      secondaries: [],
    });
  }

  const items = [...itemsByKey.values()];
  await parsePhrasesForPipeline(items, provider);
  await scoreUnityForPipeline(items, provider);
  await scoreFamiliarityForPipeline(items, provider);
  return itemsByKey;
}

async function processQueueItem(
  promptTemplate: string,
  queuePrompt: string,
  lang: string,
  provider: IAiProvider,
): Promise<void> {
  const parsedPrompt = parseQueuePrompt(queuePrompt);
  console.log(
    `Processing phrase generator queue item "${formatDisplayQuery(parsedPrompt)}" ` +
      `(base="${parsedPrompt.base}", position=${parsedPrompt.position}, lang=${lang})`,
  );

  const bannedPhrases = await getEntriesByBaseWord(
    parsedPrompt.base,
    lang,
    parsedPrompt.position,
    true,
  );
  console.log(
    `Found ${bannedPhrases.length} existing entries matching prompt for ban list`,
  );

  if (bannedPhrases.length > MATCH_SKIP_THRESHOLD) {
    console.log(
      `Prompt "${queuePrompt}" has ${bannedPhrases.length} matches (>${MATCH_SKIP_THRESHOLD}); ` +
        `deleting queue item and skipping`,
    );
    await deletePhraseGeneratorQueueItem(queuePrompt, lang);
    return;
  }

  const prompt = buildPhraseGeneratorPrompt(promptTemplate, parsedPrompt, bannedPhrases);
  console.log(
    `Sending phrase generator prompt to ${provider.sourceAI} for "${formatDisplayQuery(parsedPrompt)}"`,
  );
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(
    `Received phrase generator response for "${formatDisplayQuery(parsedPrompt)}" (${aiResponse.length} characters)`,
  );

  const phrases = parsePhraseGeneratorResponse(aiResponse);
  console.log(`Parsed ${phrases.length} phrases from phrase generator response`);

  if (phrases.length === 0) {
    console.warn(`No phrases parsed for "${queuePrompt}"; deleting queue item`);
    await deletePhraseGeneratorQueueItem(queuePrompt, lang);
    return;
  }

  const reviewedByKey = await reviewGeneratedPhrases(phrases, lang, provider);
  console.log(`Reviewed ${reviewedByKey.size} unique entry keys through parser/unity/familiarity`);

  const phraseGeneratorResults = phrases.map((phrase) => {
    const entryKey = entryToAllCaps(phrase);
    const reviewed = reviewedByKey.get(entryKey);
    return {
      prompt: queuePrompt,
      entry: entryKey,
      lang,
      baseForm: reviewed?.baseForm,
      isVulgar: reviewed?.isVulgar,
      entryType: reviewed?.entryType,
      displayText: reviewed?.displayText ?? phrase,
      unityBucket: reviewed?.unityBucket,
      familiarityBucket: reviewed?.familiarityBucket,
      secondaryClasses: reviewed?.secondaries,
    };
  }).filter((result) => result.entry !== '');

  await addPhraseGeneratorResults(phraseGeneratorResults);
  console.log(
    `Saved ${phraseGeneratorResults.length} phrases to phrase_generator_result for "${queuePrompt}"`,
  );

  const qualifyingItems = [...reviewedByKey.values()].filter(isVettablePipelineItem);
  console.log(
    `Qualified ${qualifyingItems.length}/${reviewedByKey.size} unique keys for entry insert ` +
      `(parser/unity/familiarity vetting)`,
  );

  let newlyInsertedMatching = 0;

  if (qualifyingItems.length > 0) {
    const existingEntries = await getEntries(
      qualifyingItems.map((item) => ({ entry: item.entryKey, lang })),
    );
    const existingEntryKeys = new Set(existingEntries.map((entry) => entry.entry));

    const entriesToPersist: Entry[] = qualifyingItems.map((item) => ({
      entry: item.entryKey,
      lang,
      displayText: item.displayText,
      entryType: item.entryType,
      baseForm: item.baseForm,
      isVulgar: item.isVulgar,
      unityBucket: item.unityBucket,
      unityScore: item.unityScore,
      familiarityBucket: item.familiarityBucket,
      familiarityScore: item.familiarityScore,
      reviewedStatus: REVIEWED_STATUS_AFTER_FAMILIARITY,
    }));

    await insertEntriesOrFillNulls(entriesToPersist);
    console.log(`Inserted/filled-null ${entriesToPersist.length} qualifying phrases into entry table`);

    const newEntries = qualifyingItems.filter((item) => !existingEntryKeys.has(item.entryKey));
    if (newEntries.length > 0) {
      await addEntryTags(
        newEntries.map((item) => ({
          entry: item.entryKey,
          lang,
          tag: 'phrase_generator',
        })),
      );
      console.log(`Tagged ${newEntries.length} new entries with phrase_generator`);
    }

    newlyInsertedMatching = newEntries.filter((item) =>
      phraseMatchesPosition(item.displayText, parsedPrompt.base, parsedPrompt.position),
    ).length;

    console.log(
      `Inserted ${newlyInsertedMatching} new entries matching prompt pattern`,
    );
  }

  await deletePhraseGeneratorQueueItem(queuePrompt, lang);
  console.log(`Deleted phrase generator queue item "${queuePrompt}" (${lang})`);

  if (newlyInsertedMatching >= REQUEUE_THRESHOLD) {
    await addPhraseGeneratorQueueEntries([{ prompt: queuePrompt, lang }]);
    console.log(
      `Re-queued prompt "${queuePrompt}" after ${newlyInsertedMatching} successful inserts (threshold ${REQUEUE_THRESHOLD})`,
    );
  }
}

async function processQueueItemWithTimeoutRetry(
  promptTemplate: string,
  queuePrompt: string,
  lang: string,
  provider: IAiProvider,
  itemNumber: number,
): Promise<void> {
  try {
    await processQueueItem(promptTemplate, queuePrompt, lang, provider);
  } catch (error) {
    if (!isGeminiTimeoutError(error)) {
      throw error;
    }

    console.warn(
      `AI timeout processing phrase generator item ${itemNumber}; retrying once ` +
        `("${queuePrompt}", lang=${lang})`,
    );

    try {
      await processQueueItem(promptTemplate, queuePrompt, lang, provider);
    } catch (retryError) {
      if (!isGeminiTimeoutError(retryError)) {
        throw retryError;
      }

      console.warn(
        `AI timeout on retry for phrase generator item ${itemNumber}; ` +
          `skipping and leaving queue item in place ("${queuePrompt}", lang=${lang})`,
      );
    }
  }
}

export async function phraseGenerator(
  provider: IAiProvider,
  maxItems: number = DEFAULT_MAX_ITEMS,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
): Promise<void> {
  try {
    const concurrency = Math.max(1, parallelRequests);

    console.log(
      `Starting phrase generation with provider ${provider.sourceAI} ` +
        `(max ${maxItems} queue items, ${concurrency} parallel)...`,
    );

    const promptTemplate = await loadPhraseGeneratorPromptAsync();

    let itemsCompleted = 0;
    let cycleNumber = 0;
    let shouldStop = false;

    while (itemsCompleted < maxItems && !shouldStop) {
      const remainingItems = maxItems - itemsCompleted;
      const selectLimit = Math.min(concurrency, remainingItems);

      const queueItems = await getPhraseGeneratorQueue(selectLimit);
      if (queueItems.length === 0) {
        console.log('No phrase generator queue items remaining');
        break;
      }

      cycleNumber++;
      console.log(
        `Cycle ${cycleNumber}: ${queueItems.length} parallel queue items; ` +
          `${itemsCompleted}/${maxItems} items completed so far`,
      );

      await Promise.all(
        queueItems.map(async (queueItem, index) => {
          const itemNumber = itemsCompleted + index + 1;
          console.log(
            `Processing phrase generator item ${itemNumber}/${maxItems} ` +
              `("${queueItem.prompt}", lang=${queueItem.lang})`,
          );

          try {
            await processQueueItemWithTimeoutRetry(
              promptTemplate,
              queueItem.prompt,
              queueItem.lang,
              provider,
              itemNumber,
            );
          } catch (error) {
            console.error(`Error processing phrase generator item ${itemNumber}:`, error);
            shouldStop = true;
          }
        }),
      );

      itemsCompleted += queueItems.length;
    }

    if (itemsCompleted >= maxItems) {
      console.log(`Reached max queue item limit of ${maxItems}; stopping`);
    } else {
      console.log(`Stopped after ${itemsCompleted} queue items`);
    }
  } catch (error) {
    console.error('Fatal error in phraseGenerator:', error);
    throw error;
  }
}
