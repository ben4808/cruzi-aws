/*
Keep looping through the following steps:
1. Select the first 50 entries from the entry table that do not have a familiarity score and have no entry_tags record with tag 'scrabble'.
2. For each entry, generate a prompt using the familiarity_prompt.txt file. Send the prompt to Gemini (using GeminiWebAiProvider standard mode)
   and get the response.
3. Update a few fields in the entry table with the results:
    - familiarity_score (save as the returned score * 10 to fit in an integer column)
    - upsert display_text to the parsed form in the response
    - upsert entry_type to the parsed category in the response
    - upsert root_entry to the parsed base form in the response, in the case of derived words or derived phrases

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesWithoutFamiliarityTop50,
  upsertEntries,
  EntryWithoutFamiliarity,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { scorePhrasesForFamiliarity } from './ai/phraseScoring';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { isGeminiTimeoutError, stripAccents } from './lib/utils';

const geminiProvider = new GeminiWebAiProvider();

function groupEntriesByLang(
  entries: EntryWithoutFamiliarity[],
): Map<string, EntryWithoutFamiliarity[]> {
  const byLang = new Map<string, EntryWithoutFamiliarity[]>();
  for (const entryItem of entries) {
    const items = byLang.get(entryItem.lang) ?? [];
    items.push(entryItem);
    byLang.set(entryItem.lang, items);
  }
  return byLang;
}

async function processLangGroup(entries: EntryWithoutFamiliarity[]): Promise<void> {
  const lang = entries[0].lang;
  const phrases = entries.map((entryItem) => entryItem.entry);
  const resultsByPhrase = await scorePhrasesForFamiliarity(phrases, lang, geminiProvider);

  const resultsToPersist: Entry[] = [];

  for (const entryItem of entries) {
    const parsed = resultsByPhrase.get(entryItem.entry);
    if (!parsed) {
      continue;
    }

    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      familiarityScore: parsed.familiarityScore,
      displayText: stripAccents(parsed.displayText),
      entryType: parsed.entryType,
      rootEntry: parsed.baseForm || undefined,
    });

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): score=${parsed.familiarityScore / 10}, category=${parsed.entryType}, form=${parsed.displayText}${parsed.baseForm ? `, base=${parsed.baseForm}` : ''}`,
    );
  }

  if (resultsToPersist.length > 0) {
    await upsertEntries(resultsToPersist);
    console.log(`Updated familiarity fields for ${resultsToPersist.length} ${lang} entries`);
  }
}

async function processBatch(entries: EntryWithoutFamiliarity[]): Promise<void> {
  const entriesByLang = groupEntriesByLang(entries);

  for (const [, langEntries] of entriesByLang.entries()) {
    await processLangGroup(langEntries);
  }
}

export async function familiarityGenerator(): Promise<void> {
  try {
    console.log('Starting familiarity generation...');

    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesWithoutFamiliarityTop50();
      if (entries.length === 0) {
        console.log('No entries remaining without familiarity scores');
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
