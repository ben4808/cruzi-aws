/*
Keep looping through the following steps:
1. Select the first 50 entries from the entry table that do not have a quality score and have display_text populated.
2. For each entry, generate a prompt using the quality_prompt.txt file. Use the display_text field as the input.
3. Send the prompt to Gemini (using GeminiWebAiProvider) and get the response.
4. Update the quality_score field in the entry table with the results.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesWithoutQualityTop50,
  upsertEntries,
  EntryWithoutQuality,
} from 'cruzi-db';
import { Entry, LanguageNames } from 'cruzi-models';
import { loadQualityPromptAsync, parseQualityResponse } from './ai/common';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { entryToAllCaps, isGeminiTimeoutError } from './lib/utils';

const geminiProvider = new GeminiWebAiProvider({ enforceMinRequestInterval: true });

function promptTextForEntry(entryItem: EntryWithoutQuality): string {
  return entryItem.displayText;
}

function groupEntriesByLang(
  entries: EntryWithoutQuality[],
): Map<string, EntryWithoutQuality[]> {
  const byLang = new Map<string, EntryWithoutQuality[]>();
  for (const entryItem of entries) {
    const items = byLang.get(entryItem.lang) ?? [];
    items.push(entryItem);
    byLang.set(entryItem.lang, items);
  }
  return byLang;
}

function matchParsedResultsToEntries(
  entries: EntryWithoutQuality[],
  parsedResults: ReturnType<typeof parseQualityResponse>,
): Array<{ entry: EntryWithoutQuality; parsed: (typeof parsedResults)[number] } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ entry: EntryWithoutQuality; parsed: (typeof parsedResults)[number] } | null> = [];

  for (const entryItem of entries) {
    const promptText = promptTextForEntry(entryItem);

    let matchIndex = unmatchedParsed.findIndex(
      (parsed) => parsed.displayText === promptText,
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => entryToAllCaps(parsed.entry) === entryItem.entry,
      );
    }

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => parsed.displayText.toLowerCase() === promptText.toLowerCase(),
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
  entries: EntryWithoutQuality[],
  promptTemplate: string,
): Promise<void> {
  const lang = entries[0].lang;
  const langName = LanguageNames[lang] ?? lang;
  const promptData = entries.map((entry) => promptTextForEntry(entry)).join('\n');
  const prompt = promptTemplate.replace(/\[\[LANG\]\]/g, langName).replace('[[DATA]]', promptData);

  console.log(`Sending quality prompt for ${entries.length} ${lang} entries`);
  const aiResponse = await geminiProvider.generateResultsAsync(prompt);
  console.log(`Received quality response for ${lang} batch (${aiResponse.length} characters)`);

  const parsedResults = parseQualityResponse(aiResponse);
  console.log(`Parsed ${parsedResults.length} quality results from ${lang} response`);

  if (parsedResults.length === 0) {
    console.warn(`No quality results parsed for ${lang}; skipping batch update`);
    return;
  }

  if (parsedResults.length !== entries.length) {
    console.warn(
      `Expected ${entries.length} quality results for ${lang} but parsed ${parsedResults.length}`,
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
      qualityScore: parsed.qualityScore,
    };

    resultsToPersist.push(result);

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): quality=${parsed.qualityScore / 10}`,
    );
  }

  if (resultsToPersist.length > 0) {
    await upsertEntries(resultsToPersist);
    console.log(`Updated quality fields for ${resultsToPersist.length} ${lang} entries`);
  }
}

async function processBatch(
  entries: EntryWithoutQuality[],
  promptTemplate: string,
): Promise<void> {
  const entriesByLang = groupEntriesByLang(entries);

  for (const [, langEntries] of entriesByLang.entries()) {
    await processLangGroup(langEntries, promptTemplate);
  }
}

export async function qualityGenerator(): Promise<void> {
  try {
    console.log('Starting quality generation...');

    const promptTemplate = await loadQualityPromptAsync();
    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesWithoutQualityTop50();
      if (entries.length === 0) {
        console.log('No entries remaining without quality scores');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${entries.length} entries`);

      try {
        await processBatch(entries, promptTemplate);
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing quality batch ${batchNumber}`);
          break;
        }

        console.error(`Error processing quality batch ${batchNumber}:`, error);
        break;
      }
    }
  } catch (error) {
    console.error('Fatal error in qualityGenerator:', error);
    throw error;
  }
}
