/*
Keep looping through the following steps:
1. Select 50 random rows from the phrase_generator_result table.
   OR, when a filename is passed via phraseGeneratorMiner(filename), read phrases
   one per line from that file (lang 'en'), process them in batches of 50, and skip
   steps that read/delete phrase_generator_result.
2. Normalize the phrases into entries and make a query to see which are already in the entry table. Remove
   any that already exist from the result list.
3. With the remaining phrases, first generate a prompt using the unity_prompt_2.txt file and send it to Gemini 
   (using GeminiWebAiProvider standard mode) and get the response.
   Then generate a prompt using the familiarity_prompt_updated.txt file and send it to Gemini and get the response.
4. Collect all results that get a unity result that is not Non-unit or Nonsense AND a familiarity result that
   is at least 2.5. Insert them into the entry table with their respective scores.
5. Delete all 50 queried rows from the phrase_generator_result table (DB mode only).
6. Repeat (DB mode only).

Call with phraseGeneratorMiner() to mine from phrase_generator_result, or
phraseGeneratorMiner('path/to/phrases.txt') to score a file of phrases (one per line, lang en)
in batches of 50.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  addEntryTags,
  deletePhraseGeneratorResults,
  getEntries,
  getPhraseGeneratorResultsRandom50,
  insertEntriesOrFillNulls,
  PhraseGeneratorResultRow,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import {
  computeSpokenFamiliarityScore,
  scorePhrasesForSpokenFamiliarity,
  scorePhrasesForUnityBucket,
} from './ai/phraseScoring';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { batchArray, entryToAllCaps, isGeminiTimeoutError } from './lib/utils';

const geminiProvider = new GeminiWebAiProvider();
const MIN_FAMILIARITY_SCORE = 2.5;
const MIN_FAMILIARITY_STORED = Math.round(MIN_FAMILIARITY_SCORE * 10);
const REJECTED_UNITY_BUCKETS = new Set(['Non-unit', 'Nonsense']);
const BATCH_SIZE = 50;
const MANUAL_LANG = 'en';

interface CandidatePhrase {
  phrase: string;
  lang: string;
  entryKey: string;
  displayText: string;
}

function toCandidate(phrase: string, lang: string): CandidatePhrase | null {
  const entryKey = entryToAllCaps(phrase);
  if (!entryKey) {
    return null;
  }

  return {
    phrase,
    lang,
    entryKey,
    displayText: phrase,
  };
}

async function loadPhrasesFromFile(filePath: string): Promise<string[]> {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function processBatch(
  items: Array<{ phrase: string; lang: string }>,
  options: { deleteFromQueue: boolean; sourceRows?: PhraseGeneratorResultRow[] } = {
    deleteFromQueue: false,
  },
): Promise<void> {
  console.log(`Processing ${items.length} phrases`);

  const candidatesByKey = new Map<string, CandidatePhrase>();
  for (const item of items) {
    const candidate = toCandidate(item.phrase, item.lang);
    if (!candidate) {
      console.warn(`Skipping unnormalizable phrase: "${item.phrase}"`);
      continue;
    }

    const dedupeKey = `${candidate.entryKey}|${candidate.lang}`;
    if (!candidatesByKey.has(dedupeKey)) {
      candidatesByKey.set(dedupeKey, candidate);
    }
  }

  const candidates = [...candidatesByKey.values()];
  console.log(`Normalized to ${candidates.length} unique entry keys`);

  const existingEntries = await getEntries(
    candidates.map((item) => ({ entry: item.entryKey, lang: item.lang })),
  );
  const existingKeys = new Set(existingEntries.map((entry) => `${entry.entry}|${entry.lang}`));

  const remaining = candidates.filter(
    (item) => !existingKeys.has(`${item.entryKey}|${item.lang}`),
  );
  console.log(
    `Filtered out ${candidates.length - remaining.length} existing entries; ` +
      `${remaining.length} phrases remaining for scoring`,
  );

  if (remaining.length > 0) {
    const phrases = remaining.map((item) => item.phrase);
    const unityByPhrase = await scorePhrasesForUnityBucket(phrases, geminiProvider);

    const remainingByLang = new Map<string, CandidatePhrase[]>();
    for (const item of remaining) {
      const langItems = remainingByLang.get(item.lang) ?? [];
      langItems.push(item);
      remainingByLang.set(item.lang, langItems);
    }

    const familiarityByPhrase = new Map<string, { familiarityScore: number }>();
    for (const [lang, langItems] of remainingByLang) {
      const langPhrases = langItems.map((item) => item.phrase);
      const langResults = await scorePhrasesForSpokenFamiliarity(
        langPhrases,
        lang,
        geminiProvider,
      );
      for (const [phrase, parsed] of langResults) {
        familiarityByPhrase.set(phrase, parsed);
      }
    }

    const entriesToPersist: Entry[] = [];
    const newEntryTags: Array<{ entry: string; lang: string; tag: string }> = [];

    for (const item of remaining) {
      const unity = unityByPhrase.get(item.phrase);
      const familiarity = familiarityByPhrase.get(item.phrase);

      if (!unity || !familiarity) {
        continue;
      }

      if (REJECTED_UNITY_BUCKETS.has(unity.bucket)) {
        continue;
      }

      if (familiarity.familiarityScore < MIN_FAMILIARITY_STORED) {
        continue;
      }

      const familiarityScore = computeSpokenFamiliarityScore(
        familiarity.familiarityScore,
        unity.bucket,
      );
      if (familiarityScore == null) {
        continue;
      }

      entriesToPersist.push({
        entry: item.entryKey,
        lang: item.lang,
        displayText: item.displayText,
        unityBucket: unity.bucket,
        familiarityScore,
      });
      newEntryTags.push({
        entry: item.entryKey,
        lang: item.lang,
        tag: 'phrase_generator',
      });

      console.log(
        `Qualified ${item.entryKey} (${item.lang}): ` +
          `unity=${unity.bucket}, familiarity=${familiarityScore}`,
      );
    }

    console.log(
      `Qualified ${entriesToPersist.length}/${remaining.length} phrases ` +
        `(unity not Non-unit/Nonsense, familiarity>=${MIN_FAMILIARITY_SCORE})`,
    );

    if (entriesToPersist.length > 0) {
      await insertEntriesOrFillNulls(entriesToPersist);
      console.log(`Inserted/filled-null ${entriesToPersist.length} phrases into entry table`);

      await addEntryTags(newEntryTags);
      console.log(`Tagged ${newEntryTags.length} new entries with phrase_generator`);
    }
  }

  if (options.deleteFromQueue && options.sourceRows) {
    const deletedCount = await deletePhraseGeneratorResults(
      options.sourceRows.map((row) => ({
        phrase_generator_queue_id: row.phrase_generator_queue_id,
        phrase: row.phrase,
      })),
    );
    console.log(`Deleted ${deletedCount} phrase_generator_result rows`);
  }
}

async function processPhrasesFromFile(filePath: string): Promise<void> {
  console.log(`Starting phrase generator miner from file ${filePath}...`);

  const phrases = await loadPhrasesFromFile(filePath);
  console.log(`Loaded ${phrases.length} phrases from ${filePath} (lang=${MANUAL_LANG})`);

  const items = phrases.map((phrase) => ({ phrase, lang: MANUAL_LANG }));
  const batches = batchArray(items, BATCH_SIZE);
  console.log(`Split into ${batches.length} batches of up to ${BATCH_SIZE}`);

  for (let batchNumber = 0; batchNumber < batches.length; batchNumber++) {
    const batch = batches[batchNumber];
    console.log(
      `Processing miner batch ${batchNumber + 1}/${batches.length} with ${batch.length} phrases`,
    );

    try {
      await processBatch(batch, { deleteFromQueue: false });
    } catch (error) {
      if (isGeminiTimeoutError(error)) {
        console.warn(`Gemini timeout processing miner batch ${batchNumber + 1}`);
        break;
      }

      console.error(`Error processing miner batch ${batchNumber + 1}:`, error);
      break;
    }
  }
}

async function processFromQueue(): Promise<void> {
  console.log('Starting phrase generator miner from phrase_generator_result...');

  let batchNumber = 0;

  while (true) {
    const rows = await getPhraseGeneratorResultsRandom50();
    if (rows.length === 0) {
      console.log('No phrase_generator_result rows remaining');
      break;
    }

    batchNumber++;
    console.log(`Processing miner batch ${batchNumber} with ${rows.length} rows`);

    try {
      await processBatch(rows, { deleteFromQueue: true, sourceRows: rows });
    } catch (error) {
      if (isGeminiTimeoutError(error)) {
        console.warn(`Gemini timeout processing miner batch ${batchNumber}`);
        break;
      }

      console.error(`Error processing miner batch ${batchNumber}:`, error);
      break;
    }
  }
}

export async function phraseGeneratorMiner(filename?: string): Promise<void> {
  try {
    if (filename != null) {
      await processPhrasesFromFile(filename);
      return;
    }

    await processFromQueue();
  } catch (error) {
    console.error('Fatal error in phraseGeneratorMiner:', error);
    throw error;
  }
}
