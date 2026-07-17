/*
Keep looping through the following steps:
1. Select 50 random rows from the phrase_generator_result table.
2. Normalize the phrases into entries and make a query to see which are already in the entry table. Remove
   any that already exist from the result list.
3. With the remaining phrases, first generate a prompt using the unity_prompt_2.txt file and send it to Gemini 
   (using GeminiWebAiProvider standard mode) and get the response.
   Then generate a prompt using the familiarity_prompt_updated.txt file and send it to Gemini and get the response.
4. Collect all results that get a unity result that is not Non-unit or Nonsense AND a familiarity result that
   is at least 2.5. Insert them into the entry table with their respective scores.
5. Delete all 50 queried rows from the phrase_generator_result table.
6. Repeat.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

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
import { entryToAllCaps, isGeminiTimeoutError, stripAccents } from './lib/utils';

const geminiProvider = new GeminiWebAiProvider('gemini-web');
const MIN_FAMILIARITY_SCORE = 2.5;
const MIN_FAMILIARITY_STORED = Math.round(MIN_FAMILIARITY_SCORE * 10);
const REJECTED_UNITY_BUCKETS = new Set(['Non-unit', 'Nonsense']);

interface CandidatePhrase {
  source: PhraseGeneratorResultRow;
  entryKey: string;
  displayText: string;
}

function toCandidate(row: PhraseGeneratorResultRow): CandidatePhrase | null {
  const entryKey = entryToAllCaps(row.phrase);
  if (!entryKey) {
    return null;
  }

  return {
    source: row,
    entryKey,
    displayText: stripAccents(row.phrase),
  };
}

async function processBatch(rows: PhraseGeneratorResultRow[]): Promise<void> {
  console.log(`Selected ${rows.length} random phrase_generator_result rows`);

  const candidatesByKey = new Map<string, CandidatePhrase>();
  for (const row of rows) {
    const candidate = toCandidate(row);
    if (!candidate) {
      console.warn(`Skipping unnormalizable phrase: "${row.phrase}"`);
      continue;
    }

    const dedupeKey = `${candidate.entryKey}|${candidate.source.lang}`;
    if (!candidatesByKey.has(dedupeKey)) {
      candidatesByKey.set(dedupeKey, candidate);
    }
  }

  const candidates = [...candidatesByKey.values()];
  console.log(`Normalized to ${candidates.length} unique entry keys`);

  const existingEntries = await getEntries(
    candidates.map((item) => ({ entry: item.entryKey, lang: item.source.lang })),
  );
  const existingKeys = new Set(existingEntries.map((entry) => `${entry.entry}|${entry.lang}`));

  const remaining = candidates.filter(
    (item) => !existingKeys.has(`${item.entryKey}|${item.source.lang}`),
  );
  console.log(
    `Filtered out ${candidates.length - remaining.length} existing entries; ` +
      `${remaining.length} phrases remaining for scoring`,
  );

  if (remaining.length > 0) {
    const phrases = remaining.map((item) => item.source.phrase);
    const unityByPhrase = await scorePhrasesForUnityBucket(phrases, geminiProvider);

    const remainingByLang = new Map<string, CandidatePhrase[]>();
    for (const item of remaining) {
      const langItems = remainingByLang.get(item.source.lang) ?? [];
      langItems.push(item);
      remainingByLang.set(item.source.lang, langItems);
    }

    const familiarityByPhrase = new Map<string, { familiarityScore: number }>();
    for (const [lang, langItems] of remainingByLang) {
      const langPhrases = langItems.map((item) => item.source.phrase);
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
      const unity = unityByPhrase.get(item.source.phrase);
      const familiarity = familiarityByPhrase.get(item.source.phrase);

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
        lang: item.source.lang,
        displayText: item.displayText,
        unityBucket: unity.bucket,
        familiarityScore,
      });
      newEntryTags.push({
        entry: item.entryKey,
        lang: item.source.lang,
        tag: 'phrase_generator',
      });

      console.log(
        `Qualified ${item.entryKey} (${item.source.lang}): ` +
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

  const deletedCount = await deletePhraseGeneratorResults(
    rows.map((row) => ({
      phrase_generator_queue_id: row.phrase_generator_queue_id,
      phrase: row.phrase,
    })),
  );
  console.log(`Deleted ${deletedCount} phrase_generator_result rows`);
}

export async function phraseGeneratorMiner(): Promise<void> {
  try {
    console.log('Starting phrase generator miner...');

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
        await processBatch(rows);
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing miner batch ${batchNumber}`);
          break;
        }

        console.error(`Error processing miner batch ${batchNumber}:`, error);
        break;
      }
    }
  } catch (error) {
    console.error('Fatal error in phraseGeneratorMiner:', error);
    throw error;
  }
}