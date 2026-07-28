/*
Keep looping through the following steps:
1. Select the first row from the phrase_generator_queue table that does not have a result.
2. Select all entries that have the same base word as the prompt in the phrase_generator_queue table.
3. Using phrase_generator_prompt.txt as a prompt, populate the [[QUERY]], [[BASE]], and [[START/END]] placeholders.
Populate the banned list with the results from step 2. Send the prompt to Gemini (using GeminiWebAiProvider) using the Extended Flash model.
4. After "All Full Words/Phrases Utilized:" in the response will be a list of phrases with related phrases separated by a colon. Parse all
the phrases into a single list and insert each phrase into the phrase_generator_result table.
5. Take the list of phrases and run them through two more API calls to Gemini (using GeminiWebAiProvider) using the Standard Flash model.
    a. familiarity_prompt.txt (all phrases in one call) — parses display text and classification
    b. unity_prompt.txt (display texts from familiarity, all in one call) — idiomacity/unity scores only
    - Reference the code used in idiomacity_generator.ts and familiarity_generator.ts. Refactor out common code so that there isn't
    excessive duplication.
6. Aggregate the results from both of these calls, and make a new list of all phrases that scored at least 3 on the idiomacity scale
  and 2.5 on the familiarity scale.
7. Insert these phrases into the entry table, including their respective idiomacity and familiarity scores. Do not overwrite
existing non-null entry fields; only insert new rows or populate null fields on existing rows. For entries that were not already
in the entry table, insert an entry_tag record with the tag "phrase_generator".
8. Count the number of phrases that were inserted into the entry table AND that actually start or end with the base word (depending 
on the original query). If it is 5 or more, reinsert the original row into the phrase_generator_queue table (will generate a new id).

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
  getEntries,
  getEntriesByBaseWord,
  getPhraseGeneratorQueueTop1,
  insertEntriesOrFillNulls,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import {
  combinePhraseScores,
  ParsedIdiomacityResult,
  scorePhrasesForFamiliarity,
  scorePhrasesForIdiomacity,
} from './ai/phraseScoring';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { isGeminiTimeoutError } from './lib/utils';
import { entryToAllCaps, stripAccents } from './lib/utils';

const extendedFlashProvider = new GeminiWebAiProvider();
const standardFlashProvider = new GeminiWebAiProvider();
const MIN_IDIOMACITY_SCORE = 3;
const MIN_FAMILIARITY_SCORE = 2.5;
const REQUEUE_THRESHOLD = 5;
const BLANK_PLACEHOLDER = '____';
const MIN_BASE_WORD_LETTERS = 3;
const SKIPPED_RESULT_MARKER = '__PHRASE_GENERATOR_SKIPPED__';
const MAX_BANNED_PHRASES = 200;
const MAX_STRICT_BANNED_PHRASES = 300;

export interface ParsedQueuePrompt {
  query: string;
  base: string;
  position: 'start' | 'end';
}

async function loadPhraseGeneratorPromptAsync(): Promise<string> {
  try {
    return await fs.promises.readFile('./src/ai/phrase_generator_prompt.txt', 'utf-8');
  } catch (err) {
    console.error('Error reading phrase generator prompt file:', err);
    throw err;
  }
}

export function isBaseWordTooShort(base: string): boolean {
  const letterCount = stripAccents(base).replace(/[^a-zA-Z0-9]/g, '').length;
  return letterCount <= 2;
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
    return (
      normalizedPhrase === normalizedBase ||
      normalizedPhrase.startsWith(`${normalizedBase} `)
    );
  }

  return (
    normalizedPhrase === normalizedBase ||
    normalizedPhrase.endsWith(` ${normalizedBase}`)
  );
}

async function processQueueItem(
  promptTemplate: string,
  queueId: number,
  queuePrompt: string,
  lang: string,
): Promise<void> {
  const parsedPrompt = parseQueuePrompt(queuePrompt);

  if (isBaseWordTooShort(parsedPrompt.base)) {
    console.log(
      `Skipping phrase generator queue item ${queueId}: base word "${parsedPrompt.base}" has ${stripAccents(parsedPrompt.base).replace(/[^a-zA-Z0-9]/g, '').length} letters/numerals (minimum ${MIN_BASE_WORD_LETTERS})`,
    );
    await addPhraseGeneratorResults(queueId, [SKIPPED_RESULT_MARKER]);
    return;
  }

  console.log(
    `Processing phrase generator queue item ${queueId}: "${formatDisplayQuery(parsedPrompt)}" (base="${parsedPrompt.base}", position=${parsedPrompt.position})`,
  );

  let bannedPhrases = await getEntriesByBaseWord(parsedPrompt.base, lang, parsedPrompt.position);
  console.log(
    `Found ${bannedPhrases.length} existing entries with base word "${parsedPrompt.base}" at ${parsedPrompt.position} for ban list`,
  );

  if (bannedPhrases.length > MAX_BANNED_PHRASES) {
    console.log(
      `Ban list exceeds ${MAX_BANNED_PHRASES}; re-querying with space/comma-separated base word filter`,
    );
    bannedPhrases = await getEntriesByBaseWord(
      parsedPrompt.base,
      lang,
      parsedPrompt.position,
      true,
    );
    console.log(`Strict ban list has ${bannedPhrases.length} entries`);

    if (bannedPhrases.length > MAX_STRICT_BANNED_PHRASES) {
      console.log(
        `Strict ban list still exceeds ${MAX_STRICT_BANNED_PHRASES}; skipping and removing queue item ${queueId}`,
      );
      await addPhraseGeneratorResults(queueId, [SKIPPED_RESULT_MARKER]);
      return;
    }
  }

  const prompt = buildPhraseGeneratorPrompt(promptTemplate, parsedPrompt, bannedPhrases);
  console.log(`Sending phrase generator prompt to Gemini Extended Flash for queue item ${queueId}`);
  const aiResponse = await extendedFlashProvider.generateResultsAsync(prompt);
  console.log(`Received phrase generator response for queue item ${queueId} (${aiResponse.length} characters)`);

  const phrases = parsePhraseGeneratorResponse(aiResponse);
  console.log(`Parsed ${phrases.length} phrases from phrase generator response`);

  if (phrases.length === 0) {
    console.warn(`No phrases parsed for queue item ${queueId}; recording empty result to avoid reprocessing`);
    await addPhraseGeneratorResults(queueId, ['__PHRASE_GENERATOR_EMPTY__']);
    return;
  }

  await addPhraseGeneratorResults(queueId, phrases);
  console.log(`Saved ${phrases.length} phrases to phrase_generator_result for queue item ${queueId}`);

  const familiarityByPhrase = await scorePhrasesForFamiliarity(phrases, lang, standardFlashProvider);

  const uniqueDisplayTexts: string[] = [];
  const seenDisplayTexts = new Set<string>();
  for (const phrase of phrases) {
    const familiarity = familiarityByPhrase.get(phrase);
    if (!familiarity?.displayText) {
      continue;
    }

    const displayKey = entryToAllCaps(familiarity.displayText);
    if (seenDisplayTexts.has(displayKey)) {
      continue;
    }

    seenDisplayTexts.add(displayKey);
    uniqueDisplayTexts.push(familiarity.displayText);
  }

  const idiomacityByDisplayText = await scorePhrasesForIdiomacity(
    uniqueDisplayTexts,
    standardFlashProvider,
  );

  const idiomacityByDisplayKey = new Map<string, ParsedIdiomacityResult>();
  for (const [displayText, result] of idiomacityByDisplayText) {
    idiomacityByDisplayKey.set(entryToAllCaps(displayText), result);
  }

  const idiomacityByPhrase = new Map<string, ParsedIdiomacityResult>();
  for (const phrase of phrases) {
    const familiarity = familiarityByPhrase.get(phrase);
    if (!familiarity?.displayText) {
      continue;
    }

    const idiomacity = idiomacityByDisplayKey.get(entryToAllCaps(familiarity.displayText));
    if (idiomacity) {
      idiomacityByPhrase.set(phrase, idiomacity);
    }
  }

  const qualifyingPhrases = combinePhraseScores(
    phrases,
    idiomacityByPhrase,
    familiarityByPhrase,
    MIN_IDIOMACITY_SCORE,
    MIN_FAMILIARITY_SCORE,
  );
  console.log(
    `Qualified ${qualifyingPhrases.length}/${phrases.length} phrases (idiomacity>=${MIN_IDIOMACITY_SCORE}, familiarity>=${MIN_FAMILIARITY_SCORE})`,
  );

  if (qualifyingPhrases.length === 0) {
    return;
  }

  const existingEntries = await getEntries(
    qualifyingPhrases.map((item) => ({ entry: item.entryKey, lang })),
  );
  const existingEntryKeys = new Set(existingEntries.map((entry) => entry.entry));

  const entriesToPersist: Entry[] = qualifyingPhrases.map((item) => ({
    entry: item.entryKey,
    lang,
    displayText: item.displayText,
    entryType: item.entryType,
    idiomacityScore: item.idiomacityScore,
    familiarityScore: item.familiarityScore,
    baseForm: item.baseForm,
  }));

  await insertEntriesOrFillNulls(entriesToPersist);
  console.log(`Inserted/filled-null ${entriesToPersist.length} qualifying phrases into entry table`);

  const newEntries = qualifyingPhrases.filter((item) => !existingEntryKeys.has(item.entryKey));
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

  const newlyInsertedMatching = qualifyingPhrases.filter(
    (item) =>
      !existingEntryKeys.has(item.entryKey) &&
      phraseMatchesPosition(item.displayText, parsedPrompt.base, parsedPrompt.position),
  );

  console.log(
    `Inserted ${newlyInsertedMatching.length} new entries matching base word position requirement`,
  );

  if (newlyInsertedMatching.length >= REQUEUE_THRESHOLD) {
    await addPhraseGeneratorQueueEntries([{ prompt: queuePrompt, lang }]);
    console.log(
      `Re-queued prompt "${queuePrompt}" after ${newlyInsertedMatching.length} successful inserts (threshold ${REQUEUE_THRESHOLD})`,
    );
  }
}

export async function phraseGenerator(): Promise<void> {
  try {
    console.log('Starting phrase generation...');

    const promptTemplate = await loadPhraseGeneratorPromptAsync();
    let itemNumber = 0;

    while (true) {
      const queueItem = await getPhraseGeneratorQueueTop1();
      if (!queueItem) {
        console.log('No phrase generator queue items remaining');
        break;
      }

      itemNumber++;
      console.log(`Processing phrase generator item ${itemNumber} (queue id ${queueItem.id})`);

      try {
        await processQueueItem(
          promptTemplate,
          queueItem.id,
          queueItem.prompt,
          queueItem.lang,
        );
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing phrase generator item ${itemNumber}`);
          break;
        }

        console.error(`Error processing phrase generator item ${itemNumber}:`, error);
        break;
      }
    }
  } catch (error) {
    console.error('Fatal error in phraseGenerator:', error);
    throw error;
  }
}
