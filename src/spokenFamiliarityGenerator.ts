/*
Keep looping through the following steps:
1. Select the first 50 entries from the entry table that have loading_status "P".
2. Score entries sequentially using a single GeminiWebAiProvider.
   For each entry, generate a prompt using the familiarity_prompt_updated.txt file and get the response.
3. After each batch completes, do a single bulk update of the entry table with the results:
    - familiarity_score (store the score * 10 so it's always an integer)
      If the entry has a unity_bucket value that is not Concept or Formula, set the familiarity_score to min(AI score * 10, 35).
    - loading_status = "PF"
4. Repeat.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesForSpokenFamiliarityGeneratorTop50,
  upsertEntries,
  EntryForSpokenFamiliarityGenerator,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import {
  computeSpokenFamiliarityScore,
  scorePhrasesForSpokenFamiliarity,
} from './ai/phraseScoring';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { isGeminiTimeoutError } from './lib/utils';

function getPromptText(item: EntryForSpokenFamiliarityGenerator): string {
  return item.display_text;
}

async function scoreChunk(
  entries: EntryForSpokenFamiliarityGenerator[],
  provider: GeminiWebAiProvider,
  batchNumber: number,
): Promise<Entry[]> {
  console.log(`Batch ${batchNumber}: scoring ${entries.length} entries`);

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
      `Batch ${batchNumber}: processed ${entryItem.entry} (${entryItem.lang}): ` +
        `ai_score=${parsed?.familiarityScore ?? 'n/a'}, ` +
        `unity_bucket=${entryItem.unity_bucket ?? 'null'}, ` +
        `score=${entryItem.familiarity_score ?? 'null'} -> ${familiarityScore}`,
    );
  }

  console.log(`Batch ${batchNumber}: scored ${resultsToPersist.length}/${entries.length} entries`);
  return resultsToPersist;
}

export async function spokenFamiliarityGenerator(): Promise<void> {
  try {
    console.log('Starting spoken familiarity generation (50 entries per DB batch)...');

    const provider = new GeminiWebAiProvider({
      useWebshare: false,
      headless: false,
      enforceMinRequestInterval: false,
      login: true,
    });
    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesForSpokenFamiliarityGeneratorTop50();
      if (entries.length === 0) {
        console.log('No entries remaining with loading_status P');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${entries.length} entries`);

      try {
        const resultsToPersist = await scoreChunk(entries, provider, batchNumber);

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
