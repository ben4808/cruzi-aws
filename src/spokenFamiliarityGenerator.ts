/*
Keep looping through the following steps:
1. Select entries from the entry table that have loading_status "P":
   - 5 workers: first 250 entries
   - 1 worker: first 50 entries
2. Spin up GeminiWebAiProvider instances (extended mode) in parallel, sending 50 entries to each.
   For each entry, generate a prompt using the familiarity_prompt_updated.txt file and get the response.
3. When all providers complete, do a single bulk update of the entry table with the results:
    - familiarity_score (store the score * 10 so it's always an integer)
      If the entry has a unity_bucket value that is not Concept or Formula, set the familiarity_score to min(AI score * 10, 35).
    - loading_status = "PF"
4. Repeat.

Call with spokenFamiliarityGenerator(5) or spokenFamiliarityGenerator(1).

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesForSpokenFamiliarityGeneratorTop50,
  getEntriesForSpokenFamiliarityGeneratorTop250,
  upsertEntries,
  EntryForSpokenFamiliarityGenerator,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import {
  computeSpokenFamiliarityScore,
  scorePhrasesForSpokenFamiliarity,
} from './ai/phraseScoring';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { batchArray, isGeminiTimeoutError } from './lib/utils';

export type SpokenFamiliarityWorkerCount = 1 | 5;

const CHUNK_SIZE = 50;

function getPromptText(item: EntryForSpokenFamiliarityGenerator): string {
  return item.display_text;
}

async function scoreChunk(
  entries: EntryForSpokenFamiliarityGenerator[],
  provider: GeminiWebAiProvider,
  workerIndex: number,
): Promise<Entry[]> {
  console.log(`Worker ${workerIndex}: scoring ${entries.length} entries`);

  const entriesByLang = new Map<string, EntryForSpokenFamiliarityGenerator[]>();
  for (const entryItem of entries) {
    const langEntries = entriesByLang.get(entryItem.lang) ?? [];
    langEntries.push(entryItem);
    entriesByLang.set(entryItem.lang, langEntries);
  }

  const resultsByPhrase = new Map<string, { familiarityScore: number }>();
  for (const [lang, langEntries] of entriesByLang) {
    const phrases = langEntries.map(getPromptText);
    const langResults = await scorePhrasesForSpokenFamiliarity(phrases, lang, provider);
    for (const [phrase, parsed] of langResults) {
      resultsByPhrase.set(phrase, parsed);
    }
  }

  const resultsToPersist: Entry[] = [];

  for (const entryItem of entries) {
    const parsed = resultsByPhrase.get(getPromptText(entryItem));
    const familiarityScore = computeSpokenFamiliarityScore(
      parsed?.familiarityScore,
      entryItem.unity_bucket,
    );

    if (familiarityScore == null) {
      continue;
    }

    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      familiarityScore,
      loadingStatus: 'PF',
    });

    console.log(
      `Worker ${workerIndex}: processed ${entryItem.entry} (${entryItem.lang}): ` +
        `ai_score=${parsed?.familiarityScore ?? 'n/a'}, ` +
        `unity_bucket=${entryItem.unity_bucket ?? 'null'}, ` +
        `score=${entryItem.familiarity_score ?? 'null'} -> ${familiarityScore}`,
    );
  }

  console.log(`Worker ${workerIndex}: scored ${resultsToPersist.length}/${entries.length} entries`);
  return resultsToPersist;
}

export async function spokenFamiliarityGenerator(
  workers: SpokenFamiliarityWorkerCount = 5,
): Promise<void> {
  const fetchEntries =
    workers === 5
      ? getEntriesForSpokenFamiliarityGeneratorTop250
      : getEntriesForSpokenFamiliarityGeneratorTop50;

  try {
    console.log(
      `Starting spoken familiarity generation (${workers} parallel providers, ${CHUNK_SIZE} entries each)...`,
    );

    const providers = Array.from(
      { length: workers },
      (_, workerIndex) => new GeminiWebAiProvider('gemini-web-extended-flash', workerIndex),
    );

    let batchNumber = 0;

    while (true) {
      const entries = await fetchEntries();
      if (entries.length === 0) {
        console.log('No entries remaining with loading_status P');
        break;
      }

      batchNumber++;
      const chunks = batchArray(entries, CHUNK_SIZE);
      console.log(
        `Processing batch ${batchNumber} with ${entries.length} entries across ${chunks.length} workers`,
      );

      try {
        const chunkResults = await Promise.all(
          chunks.map((chunk, workerIndex) =>
            scoreChunk(chunk, providers[workerIndex], workerIndex),
          ),
        );

        const resultsToPersist = chunkResults.flat();
        if (resultsToPersist.length > 0) {
          await upsertEntries(resultsToPersist);
          console.log(
            `Updated spoken familiarity fields for ${resultsToPersist.length} entries (batch ${batchNumber})`,
          );
        } else {
          console.warn(`Batch ${batchNumber}: no scored entries to persist`);
        }
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing spoken familiarity batch ${batchNumber}`);
          break;
        }

        console.error(`Error processing spoken familiarity batch ${batchNumber}:`, error);
        break;
      }
    }
  } catch (error) {
    console.error('Fatal error in spokenFamiliarityGenerator:', error);
    throw error;
  }
}
