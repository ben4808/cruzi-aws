/*
Keep looping through the following steps:
1. Select the first 50 entries from the entry table that have null display_text,
   and have no entry_tags record with tag 'scrabble'.
2. For each entry, generate a prompt using the strict_domain_names.txt file. Use the entry field as the input.
   Send the prompt to Gemini (using GeminiWebAiProvider extended mode) and get the response.
3. Update the display_text field in the entry table with the step 3 output.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesWithoutDisplayTextTop50,
  upsertEntries,
  EntryWithoutDisplayText,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { isGeminiTimeoutError, stripAccents } from './lib/utils';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { parseEntriesWithStrictDomainNames } from './ai/phraseScoring';

const geminiProvider = new GeminiWebAiProvider('gemini-web-extended-flash');

async function processBatch(entries: EntryWithoutDisplayText[]): Promise<void> {
  const entryKeys = entries.map((entryItem) => entryItem.entry);
  const resultsByEntry = await parseEntriesWithStrictDomainNames(entryKeys, geminiProvider);

  const resultsToPersist: Entry[] = [];

  for (const entryItem of entries) {
    const parsed = resultsByEntry.get(entryItem.entry);
    if (!parsed) {
      continue;
    }

    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      displayText: stripAccents(parsed.displayText),
    });

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): display_text=${parsed.displayText}` +
        (parsed.step2NaturalForm ? ` [step2=${parsed.step2NaturalForm}]` : ''),
    );
  }

  if (resultsToPersist.length > 0) {
    await upsertEntries(resultsToPersist);
    console.log(`Updated display_text for ${resultsToPersist.length} entries`);
  }
}

export async function strictDomainNames(): Promise<void> {
  try {
    console.log('Starting strict domain names...');

    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesWithoutDisplayTextTop50();
      if (entries.length === 0) {
        console.log('No entries remaining without display_text');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${entries.length} entries`);

      try {
        await processBatch(entries);
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing strict domain names batch ${batchNumber}`);
          break;
        }

        console.error(`Error processing strict domain names batch ${batchNumber}:`, error);
        break;
      }
    }
  } catch (error) {
    console.error('Fatal error in strictDomainNames:', error);
    throw error;
  }
}
