/*
Keep looping through the following steps until maxItems queue items have been processed (default 100), then stop:
1. Select enough queue items for parallelRequests concurrent executions via get_short_phrase_queue
   (ordered by added_at), filtered to the given length parameter.
2. For each selected queue item (up to parallelRequests in parallel):
   If processing throws, abandon that item (leave it in the queue) and continue the rest of the batch.
   a. Select all rows from the entry table that match the prompt from the queue item.
      Exclude entries whose classification or unity_bucket is Nonsense.
   b. If there are more than 200 existing entries that match the prompt, delete the queue item and add new queue items for each letter
      of the alphabet tacked on to the end of the prompt. For example, if the prompt is "AP___", add new queue items for "APA__", "APB__", etc.
      Then finish this item and continue.
      If this would leave only one blank in the prompt, ignore this step.
   c. Using phrase_generator_short_prompt_2.txt as a prompt, populate every occurrence of the [[QUERY]], [[PATTERN]], [[LENGTH]],
      [[START/END]], and [[BASE_LETTERS]] placeholders. [[PATTERN]] is the query with explicit letter positions (e.g. "A P _ _ _"). Populate the banned list with the display_text from the results from step a.
      Send the prompt to the AIProvider (make this a parameter).
   d. After "All Full Words/Phrases Utilized:" in the response will be a list of phrases with related phrases separated by a colon.
   e. Run the phrases through entry_parser_prompt_3.txt as entryParser does: display_text, classification, inflected_entry
      mappings from parsed base forms, secondary classes (when secondary_display differs from primary), and the display-key match check (Failed parse).
   f. Run successful parses through unity_prompt_3.txt as unityGenerator does (primary + secondaries, promote a good secondary
      when the primary is Partial/Variant/Formulaic/Non-unit/Nonsense, delete Non-unit/Nonsense secondaries, keep Partial/Variant/Formulaic secondaries).
   g. Run remaining items through familiarity_prompt_3.txt as familiarityGenerator does (include classification and unity bucket, secondaries
      with their own classification/unity, Obscure→Partial/Niche inference via get_partial_phrase_items, delete Obscure/Nonsense
      secondaries, promote the highest-familiarity class). Skip Nonsense classification/unity_bucket.
   h. For each phrase from step d, insert a short_phrase_result row with all fields (classification, display_text, base_form,
      unity_bucket, familiarity_bucket). Persist remaining secondaries to entry_secondary_class for keys that are
      not already in entry (same table/keys as entry).
   i. Insert into the entry table the phrases whose classification is not Nonsense, unity_bucket is not Non-unit or Nonsense,
      familiarity_bucket is not Obscure or Nonsense, and that are not Failed parse. Include classification, display_text, base_form,
      unity bucket/score (UNITY_SCORES from unityGenerator), familiarity bucket/score (FAMILIARITY_SCORES from familiarityGenerator),
      domain, and reviewed_status "123". Do not overwrite entry fields with non-null values; only insert new rows
      or populate null fields on existing rows. For entries that were not already in the entry table, insert an entry_tag record
      with the tag "short_phrase_generator".
   j. Delete the queue item from the short_phrase_queue table.
   k. Count the number of phrases that were inserted into the entry table AND that actually match the prompt of the original queue item.
      If it is 5 or more, reinsert the original row into the short_phrase_queue table.
3. maxItems is the total number of queue items to process before quitting (not the number of DB cycles).
4. length is required in queue mode: only process short_phrase_queue rows whose length column matches.
5. prompt is optional. When provided, skip the DB queue entirely and process that single prompt pattern
   instead. Length is taken from the pattern itself (prompt.length), so any length is allowed.
   lang defaults to "en" for this one-off path. Queue delete/requeue/split still apply if the item exists.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed. Use insertEntriesOrFillNulls for entry persistence.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  addEntryTags,
  addShortPhraseQueueEntries,
  addShortPhraseResults,
  deleteShortPhraseQueueItem,
  EntryForFamiliarityGenerator,
  EntryForUnityGenerator,
  getEntries,
  getEntriesMatchingShortPhrasePrompt,
  getShortPhraseQueue,
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
import {
  entryToAllCaps,
  batchArray,
  isAbandonableAiError,
  isGeminiTimeoutError,
  waitIfUnauthorized,
  withAiFailureHandling,
} from './lib/utils';
import { parsePhraseGeneratorResponse } from './phraseGenerator';
import {
  buildResultsToPersist as buildUnityGeneratorResultsToPersist,
  collectPromptPhrases as collectUnityPromptPhrases,
  UNITY_SCORES,
} from './unityGenerator';

const SHORT_PHRASE_AI_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEUE_THRESHOLD = 5;
const MATCH_SPLIT_THRESHOLD = 200;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;
const ENTRIES_PER_REQUEST = 100;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const REVIEWED_STATUS_AFTER_FAMILIARITY = '123';
const REJECTED_CLASSIFICATIONS = new Set(['Nonsense']);
const REJECTED_UNITY_BUCKETS = new Set(['Non-unit', 'Nonsense']);
const REJECTED_FAMILIARITY_BUCKETS = new Set(['Obscure', 'Nonsense']);

function secondaryIdentityKey(secondaryClass: string, secondaryDisplay: string): string {
  return `${secondaryClass}\0${secondaryDisplay}`;
}

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
  classification?: string;
  baseForm?: string;
  isVulgar?: boolean;
  parseFailed: boolean;
  secondaries: PipelineSecondary[];
  unityBucket?: string;
  unityScore?: number;
  familiarityBucket?: string;
  familiarityScore?: number;
  domain?: string;
}

export interface ParsedShortPhrasePrompt {
  query: string;
  baseLetters: string;
  position: 'start' | 'end';
  length: number;
}

async function loadShortPhraseGeneratorPromptAsync(): Promise<string> {
  try {
    return await fs.promises.readFile('./src/ai/phrase_generator_short_prompt_2.txt', 'utf-8');
  } catch (err) {
    console.error('Error reading short phrase generator prompt file:', err);
    throw err;
  }
}

export function parseShortPhraseQueuePrompt(
  prompt: string,
  length: number,
): ParsedShortPhrasePrompt {
  const trimmed = prompt.trim();
  const startMatch = trimmed.match(/^([A-Za-z0-9]+)(_+)$/);
  if (startMatch) {
    return {
      query: trimmed,
      baseLetters: startMatch[1],
      position: 'start',
      length,
    };
  }

  const endMatch = trimmed.match(/^(_+)([A-Za-z0-9]+)$/);
  if (endMatch) {
    return {
      query: trimmed,
      baseLetters: endMatch[2],
      position: 'end',
      length,
    };
  }

  throw new Error(`Unrecognized short phrase queue prompt format: ${prompt}`);
}

export function countShortPhrasePromptBlanks(prompt: string): number {
  return (prompt.match(/_/g) ?? []).length;
}

export function expandShortPhrasePromptByAlphabet(
  prompt: string,
  position: 'start' | 'end',
): string[] {
  // Expanding fills one blank; skip when that would leave only one blank (or fewer).
  if (countShortPhrasePromptBlanks(prompt) <= 2) {
    return [];
  }

  if (position === 'start') {
    const match = prompt.match(/^([A-Za-z0-9]+)(_+)$/);
    if (!match) {
      throw new Error(`Cannot expand short phrase prompt: ${prompt}`);
    }

    const base = match[1];
    const remainingBlanks = match[2].slice(1);
    return [...ALPHABET].map((letter) => `${base}${letter}${remainingBlanks}`);
  }

  const match = prompt.match(/^(_+)([A-Za-z0-9]+)$/);
  if (!match) {
    throw new Error(`Cannot expand short phrase prompt: ${prompt}`);
  }

  const remainingBlanks = match[1].slice(0, -1);
  const base = match[2];
  return [...ALPHABET].map((letter) => `${remainingBlanks}${letter}${base}`);
}

export function buildShortPhraseGeneratorPrompt(
  template: string,
  parsedPrompt: ParsedShortPhrasePrompt,
  bannedPhrases: string[],
): string {
  const bannedList = bannedPhrases.length > 0 ? bannedPhrases.join('\n') : '(none)';

  return template
    .replace(/\[\[QUERY\]\]/g, () => parsedPrompt.query.toLowerCase())
    .replace(/\[\[PATTERN\]\]/g, () => [...parsedPrompt.query.toUpperCase()].join(' '))
    .replace(/\[\[LENGTH\]\]/g, () => String(parsedPrompt.length))
    .replace(/\[\[START\/END\]\]/g, () => parsedPrompt.position)
    .replace(/\[\[BASE_LETTERS\]\]/g, () => parsedPrompt.baseLetters.toLowerCase())
    .replace('(none)', () => bannedList);
}

export function phraseMatchesShortPrompt(
  displayText: string,
  parsedPrompt: ParsedShortPhrasePrompt,
): boolean {
  const entryKey = entryToAllCaps(displayText);
  const baseKey = entryToAllCaps(parsedPrompt.baseLetters);

  if (!entryKey || entryKey.length !== parsedPrompt.length) {
    return false;
  }

  if (parsedPrompt.position === 'start') {
    return entryKey.startsWith(baseKey);
  }

  return entryKey.endsWith(baseKey);
}

function isVettablePipelineItem(item: PipelineItem): boolean {
  return (
    !item.parseFailed &&
    !!item.displayText &&
    !!item.classification &&
    !REJECTED_CLASSIFICATIONS.has(item.classification) &&
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
    item.classification = parsed.classification;
    item.baseForm = parsed.baseForm;
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
        secondary.secondaryClass === result.classification &&
        secondary.secondaryDisplay === result.displayText,
    );
    item.displayText = result.displayText;
    if (result.classification) {
      item.classification = result.classification;
    }
    if (promoted) {
      item.baseForm = promoted.secondaryBaseForm;
    }
  }

  const deleted = new Set(
    (result.secondaryClassesToDelete ?? []).map((secondary) =>
      secondaryIdentityKey(secondary.secondaryClass, secondary.secondaryDisplay),
    ),
  );
  const unityByIdentity = new Map(
    (result.secondaryClassesToUpdate ?? []).map((secondary) => [
      secondaryIdentityKey(secondary.secondaryClass, secondary.secondaryDisplay),
      secondary.unityBucket,
    ]),
  );
  item.secondaries = item.secondaries
    .filter(
      (secondary) =>
        !deleted.has(secondaryIdentityKey(secondary.secondaryClass, secondary.secondaryDisplay)),
    )
    .map((secondary) => ({
      ...secondary,
      unityBucket:
        unityByIdentity.get(secondaryIdentityKey(secondary.secondaryClass, secondary.secondaryDisplay)) ??
        secondary.unityBucket,
    }));
}

async function scoreUnityForPipeline(
  items: PipelineItem[],
  provider: IAiProvider,
): Promise<void> {
  const eligible = items.filter(
    (item) =>
      !item.parseFailed &&
      item.classification !== 'Nonsense' &&
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
      classification: item.classification ?? null,
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
  if (result.classification) {
    item.classification = result.classification;
  }
  if (result.displayText) {
    item.baseForm = result.baseForm;
  }
  if (result.domain) {
    item.domain = result.domain;
  }

  const deleted = new Set(
    (result.secondaryClassesToDelete ?? []).map((secondary) =>
      secondaryIdentityKey(secondary.secondaryClass, secondary.secondaryDisplay),
    ),
  );
  const updates = new Map(
    (result.secondaryClassesToUpdate ?? []).map((secondary) => [
      secondaryIdentityKey(secondary.secondaryClass, secondary.secondaryDisplay),
      secondary,
    ]),
  );
  item.secondaries = item.secondaries
    .filter(
      (secondary) =>
        !deleted.has(secondaryIdentityKey(secondary.secondaryClass, secondary.secondaryDisplay)),
    )
    .map((secondary) => {
      const update = updates.get(
        secondaryIdentityKey(secondary.secondaryClass, secondary.secondaryDisplay),
      );
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
    if (
      item.secondaries.some(
        (secondary) =>
          secondary.secondaryClass === inserted.secondaryClass &&
          secondary.secondaryDisplay === inserted.secondaryDisplay,
      )
    ) {
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
      item.classification !== 'Nonsense' &&
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
      classification: item.classification ?? null,
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

async function splitOversizedQueueItem(
  parsedPrompt: ParsedShortPhrasePrompt,
  lang: string,
  length: number,
  matchCount: number,
): Promise<boolean> {
  if (matchCount <= MATCH_SPLIT_THRESHOLD) {
    return false;
  }

  const expandedPrompts = expandShortPhrasePromptByAlphabet(
    parsedPrompt.query,
    parsedPrompt.position,
  );
  if (expandedPrompts.length === 0) {
    console.log(
      `Prompt "${parsedPrompt.query}" has ${matchCount} matches (>${MATCH_SPLIT_THRESHOLD}) ` +
        `but expanding would leave only one blank; continuing without split`,
    );
    return false;
  }

  console.log(
    `Prompt "${parsedPrompt.query}" has ${matchCount} matches (>${MATCH_SPLIT_THRESHOLD}); ` +
      `splitting into ${expandedPrompts.length} child prompts`,
  );

  await deleteShortPhraseQueueItem(parsedPrompt.query, lang);
  await addShortPhraseQueueEntries(
    expandedPrompts.map((prompt) => ({ prompt, lang, length })),
  );
  console.log(
    `Deleted "${parsedPrompt.query}" and queued ${expandedPrompts.length} expanded prompts`,
  );

  return true;
}

function isUnrecognizedPromptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('Unrecognized short phrase queue prompt format:');
}

/** Move a failed prompt to the back of the queue so the next cycle can take other items. */
async function deferShortPhraseQueueItem(
  prompt: string,
  lang: string,
  length: number,
): Promise<void> {
  await deleteShortPhraseQueueItem(prompt, lang);
  await addShortPhraseQueueEntries([{ prompt, lang, length }]);
}

async function processQueueItem(
  promptTemplate: string,
  queuePrompt: string,
  lang: string,
  length: number,
  provider: IAiProvider,
): Promise<void> {
  const parsedPrompt = parseShortPhraseQueuePrompt(queuePrompt, length);
  console.log(
    `Processing short phrase queue item "${parsedPrompt.query}" ` +
      `(base="${parsedPrompt.baseLetters}", position=${parsedPrompt.position}, length=${parsedPrompt.length}, lang=${lang})`,
  );

  const bannedPhrases = await getEntriesMatchingShortPhrasePrompt(
    parsedPrompt.baseLetters,
    lang,
    parsedPrompt.length,
    parsedPrompt.position,
  );
  console.log(
    `Found ${bannedPhrases.length} existing entries matching prompt for ban list`,
  );

  const didSplit = await splitOversizedQueueItem(
    parsedPrompt,
    lang,
    length,
    bannedPhrases.length,
  );
  if (didSplit) {
    return;
  }

  const prompt = buildShortPhraseGeneratorPrompt(promptTemplate, parsedPrompt, bannedPhrases);
  console.log(
    `Sending short phrase generator prompt to ${provider.sourceAI} for "${parsedPrompt.query}"`,
  );
  const aiResponse = await provider.generateResultsAsync(prompt, SHORT_PHRASE_AI_TIMEOUT_MS);
  console.log(
    `Received short phrase generator response for "${parsedPrompt.query}" (${aiResponse.length} characters)`,
  );

  const phrases = parsePhraseGeneratorResponse(aiResponse);
  console.log(`Parsed ${phrases.length} phrases from short phrase generator response`);

  if (phrases.length === 0) {
    console.warn(`No phrases parsed for "${parsedPrompt.query}"; deleting queue item`);
    await deleteShortPhraseQueueItem(queuePrompt, lang);
    return;
  }

  const reviewedByKey = await reviewGeneratedPhrases(phrases, lang, provider);
  console.log(`Reviewed ${reviewedByKey.size} unique entry keys through parser/unity/familiarity`);

  const shortPhraseResults = phrases.map((phrase) => {
    const entryKey = entryToAllCaps(phrase);
    const reviewed = reviewedByKey.get(entryKey);
    return {
      prompt: queuePrompt,
      entry: entryKey,
      lang,
      classification: reviewed?.classification,
      displayText: reviewed?.displayText ?? phrase,
      baseForm: reviewed?.baseForm,
      isVulgar: reviewed?.isVulgar,
      unityBucket: reviewed?.unityBucket,
      familiarityBucket: reviewed?.familiarityBucket,
      secondaryClasses: reviewed?.secondaries,
    };
  }).filter((result) => result.entry !== '');

  await addShortPhraseResults(shortPhraseResults);
  console.log(
    `Saved ${shortPhraseResults.length} phrases to short_phrase_result for "${parsedPrompt.query}"`,
  );

  const qualifyingItems = [...reviewedByKey.values()].filter(isVettablePipelineItem);
  console.log(
    `Qualified ${qualifyingItems.length}/${reviewedByKey.size} unique keys for entry insert ` +
      `(classification not Nonsense; unity not Non-unit/Nonsense; ` +
      `familiarity not Obscure/Nonsense; not Failed parse)`,
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
      classification: item.classification,
      baseForm: item.baseForm,
      isVulgar: item.isVulgar,
      unityBucket: item.unityBucket,
      unityScore: item.unityScore,
      familiarityBucket: item.familiarityBucket,
      familiarityScore: item.familiarityScore,
      domain: item.domain,
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
          tag: 'short_phrase_generator',
        })),
      );
      console.log(`Tagged ${newEntries.length} new entries with short_phrase_generator`);
    }

    newlyInsertedMatching = newEntries.filter((item) =>
      phraseMatchesShortPrompt(item.displayText, parsedPrompt),
    ).length;

    console.log(
      `Inserted ${newlyInsertedMatching} new entries matching prompt pattern`,
    );
  }

  await deleteShortPhraseQueueItem(queuePrompt, lang);
  console.log(`Deleted short phrase queue item "${queuePrompt}" (${lang})`);

  if (newlyInsertedMatching >= REQUEUE_THRESHOLD) {
    await addShortPhraseQueueEntries([
      { prompt: queuePrompt, lang, length },
    ]);
    console.log(
      `Re-queued prompt "${queuePrompt}" after ${newlyInsertedMatching} successful inserts (threshold ${REQUEUE_THRESHOLD})`,
    );
  }
}

export async function shortPhraseGenerator(
  provider: IAiProvider,
  length: number,
  maxItems: number = DEFAULT_MAX_ITEMS,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
  prompt?: string,
  lang: string = 'en',
): Promise<void> {
  try {
    const concurrency = Math.max(1, parallelRequests);
    const resilientProvider = withAiFailureHandling(provider);
    const promptTemplate = await loadShortPhraseGeneratorPromptAsync();

    if (prompt) {
      const promptLength = prompt.length;
      console.log(
        `Starting short phrase generation with provider ${provider.sourceAI} ` +
          `for explicit prompt "${prompt}" (length=${promptLength}, lang=${lang})...`,
      );

      try {
        await processQueueItem(promptTemplate, prompt, lang, promptLength, resilientProvider);
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`AI timeout processing explicit short phrase prompt "${prompt}"`);
          return;
        }

        console.error(`Error processing explicit short phrase prompt "${prompt}":`, error);
        throw error;
      }

      console.log(`Finished short phrase generation for explicit prompt "${prompt}"`);
      return;
    }

    console.log(
      `Starting short phrase generation with provider ${provider.sourceAI} ` +
        `(length=${length}, max ${maxItems} queue items, ${concurrency} parallel)...`,
    );

    let itemsCompleted = 0;
    let cycleNumber = 0;

    while (itemsCompleted < maxItems) {
      const remainingItems = maxItems - itemsCompleted;
      const selectLimit = Math.min(concurrency, remainingItems);

      const queueItems = await getShortPhraseQueue(selectLimit, length);
      if (queueItems.length === 0) {
        console.log(`No short phrase queue items remaining for length ${length}`);
        break;
      }

      cycleNumber++;
      console.log(
        `Cycle ${cycleNumber}: ${queueItems.length} parallel queue items; ` +
          `${itemsCompleted}/${maxItems} items completed so far`,
      );

      const cycleAiErrors: unknown[] = [];
      await Promise.all(
        queueItems.map(async (queueItem, index) => {
          const itemNumber = itemsCompleted + index + 1;
          console.log(
            `Processing short phrase item ${itemNumber}/${maxItems} ` +
              `("${queueItem.prompt}", lang=${queueItem.lang})`,
          );

          try {
            await processQueueItem(
              promptTemplate,
              queueItem.prompt,
              queueItem.lang,
              queueItem.length,
              resilientProvider,
            );
          } catch (error) {
            if (isUnrecognizedPromptError(error)) {
              console.error(
                `Unrecognized short phrase prompt "${queueItem.prompt}"; deleting it and continuing:`,
                error,
              );
              await deleteShortPhraseQueueItem(queueItem.prompt, queueItem.lang);
              return;
            }

            if (isAbandonableAiError(error)) {
              cycleAiErrors.push(error);
            }

            console.warn(
              `Abandoning short phrase item ${itemNumber} ("${queueItem.prompt}"); ` +
                `leaving it in the queue to retry later and continuing:`,
              error instanceof Error ? error.message : error,
            );
            await deferShortPhraseQueueItem(queueItem.prompt, queueItem.lang, queueItem.length);
          }
        }),
      );

      itemsCompleted += queueItems.length;

      if (itemsCompleted < maxItems) {
        await waitIfUnauthorized(cycleAiErrors, `Cycle ${cycleNumber}`);
      }
    }

    if (itemsCompleted >= maxItems) {
      console.log(`Reached max queue item limit of ${maxItems}; stopping`);
    } else {
      console.log(`Stopped after ${itemsCompleted} queue items`);
    }
  } catch (error) {
    console.error('Fatal error in shortPhraseGenerator:', error);
    throw error;
  }
}
