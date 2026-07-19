/*
Keep looping through the following steps:
1. Select the first 50 entries from the entry table that have a null unity_bucket and have display_text populated.
2. For each entry, generate a prompt using the unity_prompt_2.txt file. Use the display_text field as the input.
   Send the prompt to Gemini (using GeminiWebAiProvider extended mode) and get the response.
3. Update the unity_bucket field in the entry table with the results.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesWithoutUnityBucketTop50,
  upsertEntries,
  EntryWithoutUnityBucket,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { isGeminiTimeoutError } from './lib/utils';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { scorePhrasesForUnityBucket } from './ai/phraseScoring';

const geminiProvider = new GeminiWebAiProvider();

function getPromptText(item: EntryWithoutUnityBucket): string {
  return item.display_text;
}

async function processBatch(entries: EntryWithoutUnityBucket[]): Promise<void> {
  const phrases = entries.map(getPromptText);
  const resultsByPhrase = await scorePhrasesForUnityBucket(phrases, geminiProvider);

  const resultsToPersist: Entry[] = [];

  for (const entryItem of entries) {
    const parsed = resultsByPhrase.get(getPromptText(entryItem));
    if (!parsed) {
      continue;
    }

    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      unityBucket: parsed.bucket,
    });

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): unity_bucket=${parsed.bucket}`,
    );
  }

  if (resultsToPersist.length > 0) {
    await upsertEntries(resultsToPersist);
    console.log(`Updated unity_bucket for ${resultsToPersist.length} entries`);
  }
}

export async function unityGenerator(): Promise<void> {
  try {
    console.log('Starting unity bucket generation...');

    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesWithoutUnityBucketTop50();
      if (entries.length === 0) {
        console.log('No entries remaining without unity buckets');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${entries.length} entries`);

      try {
        await processBatch(entries);
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing unity batch ${batchNumber}`);
          break;
        }

        console.error(`Error processing unity batch ${batchNumber}:`, error);
        break;
      }
    }
  } catch (error) {
    console.error('Fatal error in unityGenerator:', error);
    throw error;
  }
}
