/*
Keep looping through the following steps:
1. Select the first 50 entries from the entry table that have loading_status "P".
2. For each entry, generate a prompt using the availability_prompt.txt file. Send the prompt to Gemini (using GeminiWebAiProvider extended mode)
   and get the response.
3. Update a few fields in the entry table with the results:
    - familiarity_score (Tier 1 = 50, Tier 2+ = 45, Tier 2- = 40, Tier 3+ = 35, Tier 3- = 30, Tier 4+ = 25, Tier 4- = 20, Tier 5+ = 15, Tier 5- = 10)
    - loading_status = "PF"

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesForFamiliarityGeneratorTop50,
  upsertEntries,
  EntryForFamiliarityGenerator,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { scorePhrasesForAvailability } from './ai/phraseScoring';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { isGeminiTimeoutError } from './lib/utils';

const geminiProvider = new GeminiWebAiProvider('gemini-web-extended-flash');

function getPromptText(item: EntryForFamiliarityGenerator): string {
  return item.display_text;
}

async function processBatch(entries: EntryForFamiliarityGenerator[]): Promise<void> {
  const phrases = entries.map(getPromptText);
  const resultsByPhrase = await scorePhrasesForAvailability(phrases, geminiProvider);

  const resultsToPersist: Entry[] = [];

  for (const entryItem of entries) {
    const parsed = resultsByPhrase.get(getPromptText(entryItem));
    if (!parsed) {
      continue;
    }

    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      familiarityScore: parsed.familiarityScore,
      loadingStatus: 'PF',
    });

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): tier=${parsed.tier}, score=${parsed.familiarityScore}`,
    );
  }

  if (resultsToPersist.length > 0) {
    await upsertEntries(resultsToPersist);
    console.log(`Updated familiarity fields for ${resultsToPersist.length} entries`);
  }
}

export async function familiarityGenerator(): Promise<void> {
  try {
    console.log('Starting familiarity generation...');

    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesForFamiliarityGeneratorTop50();
      if (entries.length === 0) {
        console.log('No entries remaining with loading_status P');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${entries.length} entries`);

      try {
        await processBatch(entries);
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing familiarity batch ${batchNumber}`);
          break;
        }

        console.error(`Error processing familiarity batch ${batchNumber}:`, error);
        break;
      }
    }
  } catch (error) {
    console.error('Fatal error in familiarityGenerator:', error);
    throw error;
  }
}
