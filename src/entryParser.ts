/*
Keep looping through the following steps:
1. Select the first 50 entries from the entry table that have loading_status "Ready".
2. For each entry, generate a prompt using the entry_parser_prompt.txt file. Use the entry field as the input.
   Send the prompt to GeminiWebProvider and get the response.
3. Update the display_text, entry_type, and root_entry (optionally if there is a base form) fields in the entry table with the results.
   Also set loading_status to "P".
   Overwrite the existing values for the fields.
   - Before sending the update, perform one final check: convert the display_text to all caps and remove all spaces and punctuation.
     If the result is not exactly the same as the original input entry, set the display_text to simply the original input entry lowercased.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesForEntryParserTop50,
  upsertEntries,
  EntryForEntryParser,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { entryToAllCaps, isGeminiTimeoutError, stripAccents } from './lib/utils';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { parseEntriesWithEntryParser } from './ai/phraseScoring';

const geminiProvider = new GeminiWebAiProvider({ enforceMinRequestInterval: false });

function resolveDisplayText(entryKey: string, parsedDisplayText: string): string {
  if (entryToAllCaps(parsedDisplayText) !== entryKey) {
    return entryKey.toLowerCase();
  }
  return parsedDisplayText;
}

async function processBatch(entries: EntryForEntryParser[]): Promise<void> {
  const entryKeys = entries.map((entryItem) => entryItem.entry);
  const resultsByEntry = await parseEntriesWithEntryParser(entryKeys, geminiProvider);

  const resultsToPersist: Entry[] = [];

  for (const entryItem of entries) {
    const parsed = resultsByEntry.get(entryItem.entry);
    if (!parsed) {
      continue;
    }

    const aiDisplayText = stripAccents(parsed.displayText);
    const displayText = resolveDisplayText(entryItem.entry, aiDisplayText);

    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      displayText,
      entryType: parsed.entryType,
      rootEntry: parsed.baseForm || undefined,
      loadingStatus: 'P',
    });

    const rejectedNote =
      displayText !== aiDisplayText ? ` [rejected AI form="${aiDisplayText}"]` : '';
    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): type=${parsed.entryType}, form=${displayText}${parsed.baseForm ? `, base=${parsed.baseForm}` : ''}${rejectedNote}`,
    );
  }

  if (resultsToPersist.length > 0) {
    await upsertEntries(resultsToPersist);
    console.log(`Updated display fields and loading_status for ${resultsToPersist.length} entries`);
  }
}

export async function entryParser(): Promise<void> {
  try {
    console.log('Starting entry parser...');

    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesForEntryParserTop50();
      if (entries.length === 0) {
        console.log('No entries remaining with loading_status Ready');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${entries.length} entries`);

      try {
        await processBatch(entries);
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing entry parser batch ${batchNumber}`);
          break;
        }

        console.error(`Error processing entry parser batch ${batchNumber}:`, error);
        break;
      }
    }
  } catch (error) {
    console.error('Fatal error in entryParser:', error);
    throw error;
  }
}
