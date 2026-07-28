/*
Keep looping through the following steps until maxItems queue items have been processed (default 100), then stop:
1. Select enough queue items for parallelRequests concurrent executions via get_short_phrase_queue
   (ordered by added_at).
2. For each selected queue item (up to parallelRequests in parallel):
   a. Select all rows from the entry table that match the prompt from the queue item.
   b. If there are more than 150 existing entries that match the prompt, delete the queue item and add new queue items for each letter
      of the alphabet tacked on to the end of the prompt. For example, if the prompt is "AP___", add new queue items for "APA__", "APB__", etc.
      Then finish this item and continue.
      If this would leave only one blank in the prompt, ignore this step.
   c. Using phrase_generator_short_prompt.txt as a prompt, populate the [[QUERY]], [[LENGTH]], [[START/END]], and [[BASE_LETTERS]] placeholders.
      Populate the banned list with the display_text from the results from step a.
      Send the prompt to the AIProvider (make this a parameter).
   d. After "All Full Words/Phrases Utilized:" in the response will be a list of phrases with related phrases separated by a colon.
   e. Take the list of phrases and run them through a call to unity_prompt_3.txt. Parse the results and filter out the phrases that were
      classified as Non-unit or Nonsense.
   f. Take the filtered list and run them through a call to familiarity_prompt_3.txt. Parse the results and filter out the phrases that were
      classified as Obscure, Barely Exists, or Nonsense.
   g. For each phrase returned in step c, insert a row into the short_phrase_result table. Include the unity bucket and familiarity bucket where possible.
   h. Insert the phrases that made it past step f into the entry table, including their respective unity bucket/score and
      familiarity bucket/score. Do not overwrite existing non-null entry fields; only insert new rows or populate null fields
      on existing rows. For entries that were not already in the entry table, insert an entry_tag record with the tag
      "short_phrase_generator".
   i. Delete the queue item from the short_phrase_queue table.
   j. Count the number of phrases that were inserted into the entry table AND that actually match the prompt of the original queue item.
      If it is 5 or more, reinsert the original row into the short_phrase_queue table.
3. maxItems is the total number of queue items to process before quitting (not the number of DB cycles).

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
  getEntries,
  getEntriesMatchingShortPhrasePrompt,
  getShortPhraseQueue,
  insertEntriesOrFillNulls,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { IAiProvider } from './ai/IAiProvider';
import {
  scorePhrasesForFamiliarityBucket,
  scorePhrasesForUnityBucket,
} from './ai/phraseScoring';
import { entryToAllCaps, isGeminiTimeoutError } from './lib/utils';
import { parsePhraseGeneratorResponse } from './phraseGenerator';

const REQUEUE_THRESHOLD = 5;
const MATCH_SPLIT_THRESHOLD = 150;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const REJECTED_UNITY_BUCKETS = new Set(['Non-unit', 'Nonsense']);
const REJECTED_FAMILIARITY_BUCKETS = new Set(['Obscure', 'Barely Exists', 'Nonsense']);

const UNITY_SCORES: Record<string, number> = {
  Concept: 5,
  Collocation: 4,
  Formula: 3,
  'Non-unit': 2,
  Nonsense: 1,
};

const FAMILIARITY_SCORES: Record<string, number> = {
  'Beginner Core': 50,
  Fundamental: 45,
  Active: 40,
  'Easy Collocation': 35,
  'Well-Known': 30,
  Inferred: 25,
  Niche: 20,
  Obscure: 15,
  'Barely Exists': 10,
  Nonsense: 0,
};

export interface ParsedShortPhrasePrompt {
  query: string;
  baseLetters: string;
  position: 'start' | 'end';
  length: number;
}

async function loadShortPhraseGeneratorPromptAsync(): Promise<string> {
  try {
    return await fs.promises.readFile('./src/ai/phrase_generator_short_prompt.txt', 'utf-8');
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
    .replace('[[QUERY]]', parsedPrompt.query)
    .replace('[[LENGTH]]', String(parsedPrompt.length))
    .replace('[[START/END]]', parsedPrompt.position)
    .replace('[[BASE_LETTERS]]', parsedPrompt.baseLetters.toLowerCase())
    .replace('(none)', bannedList);
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
  const aiResponse = await provider.generateResultsAsync(prompt);
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

  const unityByPhrase = await scorePhrasesForUnityBucket(phrases, provider, {
    promptVersion: 3,
  });

  const unityQualifiedPhrases = phrases.filter((phrase) => {
    const unity = unityByPhrase.get(phrase);
    return unity != null && !REJECTED_UNITY_BUCKETS.has(unity.bucket);
  });
  console.log(
    `Qualified ${unityQualifiedPhrases.length}/${phrases.length} phrases (unity not Non-unit/Nonsense)`,
  );

  const familiarityByPhrase = await scorePhrasesForFamiliarityBucket(
    unityQualifiedPhrases.map((phrase) => ({
      phrase,
      unityBucket: unityByPhrase.get(phrase)!.bucket,
    })),
    provider,
  );

  const shortPhraseResults = phrases.map((phrase) => {
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

  await addShortPhraseResults(shortPhraseResults);
  console.log(
    `Saved ${shortPhraseResults.length} phrases to short_phrase_result for "${parsedPrompt.query}"`,
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
  maxItems: number = DEFAULT_MAX_ITEMS,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
): Promise<void> {
  try {
    const concurrency = Math.max(1, parallelRequests);

    console.log(
      `Starting short phrase generation with provider ${provider.sourceAI} ` +
        `(max ${maxItems} queue items, ${concurrency} parallel)...`,
    );

    const promptTemplate = await loadShortPhraseGeneratorPromptAsync();

    let itemsCompleted = 0;
    let cycleNumber = 0;
    let shouldStop = false;

    while (itemsCompleted < maxItems && !shouldStop) {
      const remainingItems = maxItems - itemsCompleted;
      const selectLimit = Math.min(concurrency, remainingItems);

      const queueItems = await getShortPhraseQueue(selectLimit);
      if (queueItems.length === 0) {
        console.log('No short phrase queue items remaining');
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
            `Processing short phrase item ${itemNumber}/${maxItems} ` +
              `("${queueItem.prompt}", lang=${queueItem.lang})`,
          );

          try {
            await processQueueItem(
              promptTemplate,
              queueItem.prompt,
              queueItem.lang,
              queueItem.length,
              provider,
            );
          } catch (error) {
            if (isGeminiTimeoutError(error)) {
              console.warn(`AI timeout processing short phrase item ${itemNumber}`);
              shouldStop = true;
              return;
            }

            console.error(`Error processing short phrase item ${itemNumber}:`, error);
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
    console.error('Fatal error in shortPhraseGenerator:', error);
    throw error;
  }
}
