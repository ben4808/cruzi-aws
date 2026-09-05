/*
Keep looping through the following steps until maxItems queue items have been processed (default 100), then stop:
1. Select enough queue items for parallelRequests concurrent executions via get_short_phrase_queue
   (ordered by added_at), filtered to the given length parameter.
2. For each selected queue item (up to parallelRequests in parallel):
   a. Select all rows from the entry table that match the prompt from the queue item.
   b. If there are more than 200 existing entries that match the prompt, delete the queue item and add new queue items for each letter
      of the alphabet tacked on to the end of the prompt. For example, if the prompt is "AP___", add new queue items for "APA__", "APB__", etc.
      Then finish this item and continue.
      If this would leave only one blank in the prompt, ignore this step.
   c. Using phrase_generator_short_prompt_2.txt as a prompt, populate the [[QUERY]], [[LENGTH]], [[START/END]], and [[BASE_LETTERS]] placeholders.
      Populate the banned list with the display_text from the results from step a.
      Send the prompt to the AIProvider (make this a parameter).
   d. After "All Full Words/Phrases Utilized:" in the response will be a list of phrases with related phrases separated by a colon.
   e. Normalize those phrases to ALLCAPS and run them through entry_parser_prompt_3.txt. Parse entry_type, display_text,
      base_form, and is_vulgar. Match parser/unity/familiarity results by identity only (never shift leftover rows).
   f. Run the parsed phrases through unity_prompt_3.txt, then through familiarity_prompt_3.txt.
   g. For each phrase returned in step c, insert a row into the short_phrase_result table. Include entry_type, display_text,
      base_form, is_vulgar, unity_bucket, and familiarity_bucket where possible.
   h. Insert into the entry table the phrases whose entry_type is not Nonsense, unity_bucket is not Variant, Non-unit, or Nonsense,
      and familiarity_bucket is not Obscure, Barely Exists, or Nonsense. Include entry_type, display_text, base_form, is_vulgar,
      unity bucket/score, and familiarity bucket/score. Do not overwrite entry fields with non-null values; only insert new rows
      or populate null fields on existing rows. For entries that were not already in the entry table, insert an entry_tag record
      with the tag "short_phrase_generator".
   i. Delete the queue item from the short_phrase_queue table.
   j. Count the number of phrases that were inserted into the entry table AND that actually match the prompt of the original queue item.
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
  getEntries,
  getEntriesMatchingShortPhrasePrompt,
  getShortPhraseQueue,
  insertEntriesOrFillNulls,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { IAiProvider } from './ai/IAiProvider';
import {
  parseEntriesWithEntryParser3,
  scorePhrasesForFamiliarityBucket,
  scorePhrasesForUnityBucket,
} from './ai/phraseScoring';
import { entryToAllCaps, isGeminiTimeoutError } from './lib/utils';
import { parsePhraseGeneratorResponse } from './phraseGenerator';

const SHORT_PHRASE_AI_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEUE_THRESHOLD = 5;
const MATCH_SPLIT_THRESHOLD = 200;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const REJECTED_ENTRY_TYPES = new Set(['Nonsense']);
const REJECTED_UNITY_BUCKETS = new Set(['Variant', 'Non-unit', 'Nonsense']);
const REJECTED_FAMILIARITY_BUCKETS = new Set(['Obscure', 'Barely Exists', 'Nonsense']);

const UNITY_SCORES: Record<string, number> = {
  Concept: 5,
  Collocation: 4,
  Formula: 3,
  Partial: 2,
  Variant: 2,
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
  Colloquial: 30,
  Inferred: 25,
  Niche: 20,
  Variant: 20,
  'Partial Phrase': 20,
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

  const uniqueByEntryKey = new Map<string, string>();
  for (const phrase of phrases) {
    const entryKey = entryToAllCaps(phrase);
    if (entryKey && !uniqueByEntryKey.has(entryKey)) {
      uniqueByEntryKey.set(entryKey, phrase);
    }
  }
  const entryKeys = [...uniqueByEntryKey.keys()];
  console.log(`Normalized ${entryKeys.length} unique ALLCAPS entries for entry parser`);

  const parsedByEntry = await parseEntriesWithEntryParser3(entryKeys, provider);
  console.log(`Parsed ${parsedByEntry.size}/${entryKeys.length} entries with entry_parser_prompt_3`);

  const displayByEntry = new Map<string, string>();
  const entryTypeByEntry = new Map<string, string>();
  const baseFormByEntry = new Map<string, string>();
  const isVulgarByEntry = new Map<string, boolean>();
  for (const entryKey of entryKeys) {
    const parsed = parsedByEntry.get(entryKey);
    if (parsed) {
      entryTypeByEntry.set(entryKey, parsed.entryType);
      displayByEntry.set(entryKey, parsed.displayText);
      if (parsed.baseForm) {
        baseFormByEntry.set(entryKey, parsed.baseForm);
      }
      if (parsed.isVulgar != null) {
        isVulgarByEntry.set(entryKey, parsed.isVulgar);
      }
    } else {
      displayByEntry.set(entryKey, uniqueByEntryKey.get(entryKey)!);
    }
  }

  const unityInputs = entryKeys.map((entryKey) => displayByEntry.get(entryKey)!);
  const unityByDisplay = await scorePhrasesForUnityBucket(unityInputs, provider, {
    promptVersion: 3,
  });
  const unityByEntry = new Map<string, { parsedForm: string; bucket: string }>();
  for (const entryKey of entryKeys) {
    const displayText = displayByEntry.get(entryKey)!;
    const unity = unityByDisplay.get(displayText);
    if (unity) {
      unityByEntry.set(entryKey, unity);
    }
  }

  const familiarityInputs = entryKeys.flatMap((entryKey) => {
    const entryType = entryTypeByEntry.get(entryKey);
    const unity = unityByEntry.get(entryKey);
    if (!entryType || !unity) {
      return [];
    }
    return [{
      phrase: displayByEntry.get(entryKey)!,
      entryType,
      unityBucket: unity.bucket,
    }];
  });
  const familiarityByDisplay = await scorePhrasesForFamiliarityBucket(
    familiarityInputs,
    provider,
  );
  const familiarityByEntry = new Map<string, { parsedForm: string; bucket: string }>();
  for (const entryKey of entryKeys) {
    const displayText = displayByEntry.get(entryKey)!;
    const familiarity = familiarityByDisplay.get(displayText);
    if (familiarity) {
      familiarityByEntry.set(entryKey, familiarity);
    }
  }

  const shortPhraseResults = entryKeys.map((entryKey) => ({
    prompt: queuePrompt,
    entry: entryKey,
    lang,
    entryType: entryTypeByEntry.get(entryKey),
    displayText: displayByEntry.get(entryKey),
    baseForm: baseFormByEntry.get(entryKey),
    isVulgar: isVulgarByEntry.get(entryKey),
    unityBucket: unityByEntry.get(entryKey)?.bucket,
    familiarityBucket: familiarityByEntry.get(entryKey)?.bucket,
  }));

  await addShortPhraseResults(shortPhraseResults);
  console.log(
    `Saved ${shortPhraseResults.length} phrases to short_phrase_result for "${parsedPrompt.query}"`,
  );

  const qualifyingEntries = entryKeys.filter((entryKey) => {
    const entryType = entryTypeByEntry.get(entryKey);
    const unity = unityByEntry.get(entryKey);
    const familiarity = familiarityByEntry.get(entryKey);
    return (
      entryType != null &&
      !REJECTED_ENTRY_TYPES.has(entryType) &&
      unity != null &&
      !REJECTED_UNITY_BUCKETS.has(unity.bucket) &&
      familiarity != null &&
      !REJECTED_FAMILIARITY_BUCKETS.has(familiarity.bucket)
    );
  });
  console.log(
    `Qualified ${qualifyingEntries.length}/${entryKeys.length} phrases ` +
      `(entry_type not Nonsense; unity not Variant/Non-unit/Nonsense; ` +
      `familiarity not Obscure/Barely Exists/Nonsense)`,
  );

  let newlyInsertedMatching = 0;

  if (qualifyingEntries.length > 0) {
    const candidatesByKey = new Map<
      string,
      {
        entryKey: string;
        displayText: string;
        entryType: string;
        baseForm?: string;
        isVulgar?: boolean;
        unityBucket: string;
        unityScore: number;
        familiarityBucket: string;
        familiarityScore: number;
      }
    >();

    for (const entryKey of qualifyingEntries) {
      const unity = unityByEntry.get(entryKey)!;
      const unityScore = UNITY_SCORES[unity.bucket];
      if (unityScore == null) {
        continue;
      }

      const familiarity = familiarityByEntry.get(entryKey)!;
      const familiarityScore = FAMILIARITY_SCORES[familiarity.bucket];
      if (familiarityScore == null) {
        continue;
      }

      if (!candidatesByKey.has(entryKey)) {
        candidatesByKey.set(entryKey, {
          entryKey,
          displayText: displayByEntry.get(entryKey)!,
          entryType: entryTypeByEntry.get(entryKey)!,
          baseForm: baseFormByEntry.get(entryKey),
          isVulgar: isVulgarByEntry.get(entryKey),
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
      entryType: item.entryType,
      baseForm: item.baseForm,
      isVulgar: item.isVulgar,
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
  length: number,
  maxItems: number = DEFAULT_MAX_ITEMS,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
  prompt?: string,
  lang: string = 'en',
): Promise<void> {
  try {
    const concurrency = Math.max(1, parallelRequests);
    const promptTemplate = await loadShortPhraseGeneratorPromptAsync();

    if (prompt) {
      const promptLength = prompt.length;
      console.log(
        `Starting short phrase generation with provider ${provider.sourceAI} ` +
          `for explicit prompt "${prompt}" (length=${promptLength}, lang=${lang})...`,
      );

      try {
        await processQueueItem(promptTemplate, prompt, lang, promptLength, provider);
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
    let shouldStop = false;

    while (itemsCompleted < maxItems && !shouldStop) {
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
