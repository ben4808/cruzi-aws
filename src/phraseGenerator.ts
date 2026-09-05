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
   e. Take the list of phrases and run them through a call to unity_prompt_3.txt. Parse the results and filter out the phrases that were
      classified as Partial, Non-unit, or Nonsense.
   f. Take the filtered list and run them through a call to familiarity_prompt_3.txt. Parse the results and filter out the phrases that were
      classified as Obscure, Barely Exists, or Nonsense.
   g. For each phrase returned in step c, insert a row into the phrase_generator_result table. Include the unity bucket and familiarity bucket where possible.
   h. Insert the phrases that made it past step f into the entry table, including their respective display text, unity bucket/score and
      familiarity bucket/score. Do not overwrite existing entry fields with non-null values; only insert new rows or populate null fields
      on existing rows. For entries that were not already in the entry table, insert an entry_tag record with the tag
      "phrase_generator".
   i. Delete the queue item from the phrase_generator_queue table.
   j. Count the number of phrases that were inserted into the entry table that actually match the prompt of the original queue item.
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
  getEntries,
  getEntriesByBaseWord,
  getPhraseGeneratorQueue,
  insertEntriesOrFillNulls,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { IAiProvider } from './ai/IAiProvider';
import {
  scorePhrasesForFamiliarityBucket,
  scorePhrasesForUnityBucket,
} from './ai/phraseScoring';
import { entryToAllCaps, isGeminiTimeoutError, stripAccents } from './lib/utils';

const REQUEUE_THRESHOLD = 5;
const MATCH_SKIP_THRESHOLD = 200;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;
const BLANK_PLACEHOLDER = '____';
const REJECTED_UNITY_BUCKETS = new Set(['Partial', 'Non-unit', 'Nonsense']);
const REJECTED_FAMILIARITY_BUCKETS = new Set(['Obscure', 'Barely Exists', 'Nonsense']);

const UNITY_SCORES: Record<string, number> = {
  Concept: 5,
  Collocation: 4,
  Formula: 3,
  Partial: 2,
  'Non-unit': 2,
  Nonsense: 1,
};

const FAMILIARITY_SCORES: Record<string, number> = {
  'Beginner Core': 50,
  Ubiquitous: 45,
  Active: 40,
  'Easy Collocation': 35,
  'Common Name': 30,
  'General Knowledge': 30,
  Inferred: 25,
  Niche: 20,
  Obscure: 15,
  'Barely Exists': 10,
  Nonsense: 0,
};

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

  const unityByPhrase = await scorePhrasesForUnityBucket(phrases, provider, {
    promptVersion: 3,
  });

  const unityQualifiedPhrases = phrases.filter((phrase) => {
    const unity = unityByPhrase.get(phrase);
    return unity != null && !REJECTED_UNITY_BUCKETS.has(unity.bucket);
  });
  console.log(
    `Qualified ${unityQualifiedPhrases.length}/${phrases.length} phrases (unity not Partial/Non-unit/Nonsense)`,
  );

  const familiarityByPhrase = await scorePhrasesForFamiliarityBucket(
    unityQualifiedPhrases.map((phrase) => ({
      phrase,
      entryType: 'Phrase',
      unityBucket: unityByPhrase.get(phrase)!.bucket,
    })),
    provider,
  );

  const phraseGeneratorResults = phrases.map((phrase) => {
    const entryKey = entryToAllCaps(phrase);
    const unity = unityByPhrase.get(phrase);
    const familiarity = familiarityByPhrase.get(phrase);
    return {
      prompt: queuePrompt,
      entry: entryKey,
      lang,
      displayText: phrase,
      unityBucket: unity?.bucket,
      familiarityBucket: familiarity?.bucket,
    };
  }).filter((result) => result.entry !== '');

  await addPhraseGeneratorResults(phraseGeneratorResults);
  console.log(
    `Saved ${phraseGeneratorResults.length} phrases to phrase_generator_result for "${queuePrompt}"`,
  );

  const qualifyingPhrases = unityQualifiedPhrases.filter((phrase) => {
    const familiarity = familiarityByPhrase.get(phrase);
    return familiarity != null && !REJECTED_FAMILIARITY_BUCKETS.has(familiarity.bucket);
  });
  console.log(
    `Qualified ${qualifyingPhrases.length}/${unityQualifiedPhrases.length} unity-qualified phrases ` +
      `(familiarity not Obscure/Barely Exists/Nonsense)`,
  );

  let newlyInsertedMatching = 0;

  if (qualifyingPhrases.length > 0) {
    const candidatesByKey = new Map<
      string,
      {
        entryKey: string;
        displayText: string;
        unityBucket: string;
        unityScore: number;
        familiarityBucket: string;
        familiarityScore: number;
      }
    >();

    for (const phrase of qualifyingPhrases) {
      const entryKey = entryToAllCaps(phrase);
      if (!entryKey) {
        continue;
      }

      const unity = unityByPhrase.get(phrase)!;
      const unityScore = UNITY_SCORES[unity.bucket];
      if (unityScore == null) {
        continue;
      }

      const familiarity = familiarityByPhrase.get(phrase)!;
      const familiarityScore = FAMILIARITY_SCORES[familiarity.bucket];
      if (familiarityScore == null) {
        continue;
      }

      if (!candidatesByKey.has(entryKey)) {
        candidatesByKey.set(entryKey, {
          entryKey,
          displayText: phrase,
          unityBucket: unity.bucket,
          unityScore,
          familiarityBucket: familiarity.bucket,
          familiarityScore,
        });
      }
    }

    const candidates = [...candidatesByKey.values()];
    const existingEntries = await getEntries(
      candidates.map((item) => ({ entry: item.entryKey, lang })),
    );
    const existingEntryKeys = new Set(existingEntries.map((entry) => entry.entry));

    const entriesToPersist: Entry[] = candidates.map((item) => ({
      entry: item.entryKey,
      lang,
      displayText: item.displayText,
      unityBucket: item.unityBucket,
      unityScore: item.unityScore,
      familiarityBucket: item.familiarityBucket,
      familiarityScore: item.familiarityScore,
    }));

    await insertEntriesOrFillNulls(entriesToPersist);
    console.log(`Inserted/filled-null ${entriesToPersist.length} qualifying phrases into entry table`);

    const newEntries = candidates.filter((item) => !existingEntryKeys.has(item.entryKey));
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
