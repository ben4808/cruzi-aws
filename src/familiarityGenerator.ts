/*
Keep looping through the following steps:
1. Select the first 50 entries from the entry table that do not have an familiarity score.
2. For each entry, generate a prompt using the familiarity_prompt.txt file. Send the prompt to Gemini (using GeminiWebAiProvider)
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
import { Entry, LanguageNames } from 'cruzi-models';
import { loadFamiliarityPromptAsync, parseFamiliarityResponse } from './ai/common';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { entryToAllCaps, stripAccents } from './lib/utils';

const geminiProvider = new GeminiWebAiProvider();
const MAX_BATCH_RETRIES = 5;

function isGeminiTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out/i.test(message);
}

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

function matchParsedResultsToEntries(
  entries: EntryWithoutFamiliarity[],
  parsedResults: ReturnType<typeof parseFamiliarityResponse>,
): Array<{ entry: EntryWithoutFamiliarity; parsed: (typeof parsedResults)[number] } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ entry: EntryWithoutFamiliarity; parsed: (typeof parsedResults)[number] } | null> = [];

  for (const entryItem of entries) {
    let matchIndex = unmatchedParsed.findIndex(
      (parsed) => entryToAllCaps(parsed.entry) === entryItem.entry,
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex((parsed) => parsed.entry === entryItem.entry);
    }

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => parsed.entry.toLowerCase() === entryItem.entry.toLowerCase(),
      );
    }

    if (matchIndex === -1 && unmatchedParsed.length > 0) {
      matchIndex = 0;
    }

    if (matchIndex === -1) {
      matches.push(null);
      continue;
    }

    const [parsed] = unmatchedParsed.splice(matchIndex, 1);
    matches.push({ entry: entryItem, parsed });
  }

  return matches;
}

async function processLangGroup(
  entries: EntryWithoutFamiliarity[],
  promptTemplate: string,
): Promise<void> {
  const lang = entries[0].lang;
  const langName = LanguageNames[lang] ?? lang;
  const promptData = entries.map((entry) => entry.entry).join('\n');
  const prompt = promptTemplate.replace(/\[\[LANG\]\]/g, langName).replace('[[DATA]]', promptData);

  console.log(`Sending familiarity prompt for ${entries.length} ${lang} entries`);
  const aiResponse = await geminiProvider.generateResultsAsync(prompt);
  console.log(`Received familiarity response for ${lang} batch (${aiResponse.length} characters)`);

  const parsedResults = parseFamiliarityResponse(aiResponse);
  console.log(`Parsed ${parsedResults.length} familiarity results from ${lang} response`);

  if (parsedResults.length === 0) {
    console.warn(`No familiarity results parsed for ${lang}; skipping batch update`);
    return;
  }

  if (parsedResults.length !== entries.length) {
    console.warn(
      `Expected ${entries.length} familiarity results for ${lang} but parsed ${parsedResults.length}`,
    );
  }

  const matches = matchParsedResultsToEntries(entries, parsedResults);
  const resultsToPersist: Entry[] = [];

  for (const match of matches) {
    if (!match) {
      continue;
    }

    const { entry: entryItem, parsed } = match;
    const result: Entry = {
      entry: entryItem.entry,
      lang: entryItem.lang,
      familiarityScore: parsed.familiarityScore,
      displayText: stripAccents(parsed.displayText),
      entryType: parsed.entryType,
      rootEntry: parsed.baseForm || undefined,
    };

    resultsToPersist.push(result);

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): score=${parsed.familiarityScore / 10}, category=${parsed.entryType}, form=${parsed.displayText}${parsed.baseForm ? `, base=${parsed.baseForm}` : ''}`,
    );
  }

  if (resultsToPersist.length > 0) {
    await upsertEntries(resultsToPersist);
    console.log(`Updated familiarity fields for ${resultsToPersist.length} ${lang} entries`);
  }
}

async function processBatch(
  entries: EntryWithoutFamiliarity[],
  promptTemplate: string,
): Promise<void> {
  const entriesByLang = groupEntriesByLang(entries);

  for (const [, langEntries] of entriesByLang.entries()) {
    await processLangGroup(langEntries, promptTemplate);
  }
}

export async function familiarityGenerator(): Promise<void> {
  try {
    console.log('Starting familiarity generation...');

    const promptTemplate = await loadFamiliarityPromptAsync();
    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesWithoutFamiliarityTop50();
      if (entries.length === 0) {
        console.log('No entries remaining without familiarity scores');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${entries.length} entries`);

      let batchSucceeded = false;
      for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
        try {
          await processBatch(entries, promptTemplate);
          batchSucceeded = true;
          break;
        } catch (error) {
          if (isGeminiTimeoutError(error) && attempt < MAX_BATCH_RETRIES) {
            console.warn(
              `Gemini timeout processing familiarity batch ${batchNumber} (attempt ${attempt}/${MAX_BATCH_RETRIES}), retrying...`,
            );
            continue;
          }

          console.error(`Error processing familiarity batch ${batchNumber}:`, error);
          break;
        }
      }

      if (!batchSucceeded) {
        break;
      }
    }

    console.log('Familiarity generation completed');
  } catch (error) {
    console.error('Fatal error in familiarityGenerator:', error);
    throw error;
  }
}
