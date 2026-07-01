/*
Keep looping through the following steps:
1. Select all entries from the entry table that have an idiomacity score < 3 and are alphabetically later than HINDERANCES, then batch them into groups of 150 in memory.
2. For each entry, generate a prompt using the phrase_idiomacity_prompt_2.txt file. Send the prompt to Gemini (using GeminiWebAiProvider)
   and get the response.
3. Not all input entries will return a response. For those that do, update a few fields in the entry table with the results:
    - idiomacity_score
    - upsert the display_text to the parsed form in the response
    - upsert the entry_type to the parsed category in the response

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import { Entry } from 'cruzi-models';
import {
  getEntriesLowIdiomacity,
  upsertEntries,
  EntryWithLowIdiomacity,
} from 'cruzi-db';
import { entryToAllCaps, stripAccents } from './lib/utils';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { ParsedIdiomacityResult } from './ai/phraseScoring';

const geminiProvider = new GeminiWebAiProvider();
const BATCH_SIZE = 150;
const AFTER_ENTRY = 'HINDERANCES';

async function loadIdiomacityPromptRound2Async(): Promise<string> {
  try {
    const promptPath = './src/ai/phrase_idiomacity_prompt_2.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading idiomacity round 2 prompt file:', err);
    throw err;
  }
}

export function parseIdiomacityResponseRound2(response: string): ParsedIdiomacityResult[] {
  const summaryIndex = response.indexOf('SUMMARY:');
  const textToParse = summaryIndex === -1 ? response : response.slice(summaryIndex + 'SUMMARY:'.length);
  const lines = textToParse.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedIdiomacityResult[] = [];
  for (const line of lines) {
    const parts = line.split(' : ').map((part) => part.trim());
    if (parts.length < 3) {
      continue;
    }

    const score = parseInt(parts[2], 10);
    if (Number.isNaN(score)) {
      continue;
    }

    results.push({
      parsedForm: parts[0],
      category: parts[1],
      score,
    });
  }

  return results;
}

function getPromptText(item: EntryWithLowIdiomacity): string {
  return item.entry;
}

function normalizeForEntryMatch(text: string): string {
  return entryToAllCaps(stripAccents(text));
}

function matchParsedResultsToEntries(
  entries: EntryWithLowIdiomacity[],
  parsedResults: ParsedIdiomacityResult[],
): Array<{ entry: EntryWithLowIdiomacity; parsed: ParsedIdiomacityResult }> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ entry: EntryWithLowIdiomacity; parsed: ParsedIdiomacityResult }> = [];

  for (const entryItem of entries) {
    const entryNormalized = normalizeForEntryMatch(entryItem.entry);

    let matchIndex = unmatchedParsed.findIndex(
      (parsed) => entryToAllCaps(parsed.parsedForm) === entryItem.entry,
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => normalizeForEntryMatch(parsed.parsedForm) === entryNormalized,
      );
    }

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => parsed.parsedForm.toLowerCase() === entryItem.entry.toLowerCase(),
      );
    }

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) =>
          stripAccents(parsed.parsedForm).toLowerCase() ===
          stripAccents(entryItem.entry).toLowerCase(),
      );
    }

    if (matchIndex === -1) {
      continue;
    }

    const [parsed] = unmatchedParsed.splice(matchIndex, 1);
    matches.push({ entry: entryItem, parsed });
  }

  return matches;
}

async function processBatch(
  entries: EntryWithLowIdiomacity[],
  promptTemplate: string,
): Promise<void> {
  const promptData = entries.map(getPromptText).join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending idiomacity round 2 prompt for ${entries.length} entries`);
  const aiResponse = await geminiProvider.generateResultsAsync(prompt);
  console.log(`Received idiomacity round 2 response for batch (${aiResponse.length} characters)`);

  const parsedResults = parseIdiomacityResponseRound2(aiResponse);
  console.log(`Parsed ${parsedResults.length} qualifying idiomacity results from response`);

  if (parsedResults.length === 0) {
    console.warn('No qualifying idiomacity results parsed; skipping batch update');
    return;
  }

  const matches = matchParsedResultsToEntries(entries, parsedResults);
  const skippedCount = entries.length - matches.length;
  if (skippedCount > 0) {
    console.log(`${skippedCount} entries had no qualifying response and will not be updated`);
  }

  const entriesToPersist: Entry[] = matches.map(({ entry: entryItem, parsed }) => {
    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): score=${parsed.score}, category=${parsed.category}, form=${parsed.parsedForm}`,
    );

    return {
      entry: entryItem.entry,
      lang: entryItem.lang,
      displayText: parsed.parsedForm,
      entryType: parsed.category,
      idiomacityScore: parsed.score,
    };
  });

  if (entriesToPersist.length > 0) {
    await upsertEntries(entriesToPersist);
    console.log(`Updated idiomacity fields for ${entriesToPersist.length} entries`);
  }
}

export async function idiomacityGeneratorRound2(): Promise<void> {
  try {
    console.log('Starting idiomacity generation round 2...');

    const promptTemplate = await loadIdiomacityPromptRound2Async();
    const allEntries = await getEntriesLowIdiomacity(AFTER_ENTRY);

    if (allEntries.length === 0) {
      console.log(`No entries with idiomacity score below 3 after ${AFTER_ENTRY}`);
      return;
    }

    console.log(
      `Found ${allEntries.length} entries with idiomacity score below 3 after ${AFTER_ENTRY}`,
    );

    const totalBatches = Math.ceil(allEntries.length / BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const batchStart = batchIndex * BATCH_SIZE;
      const entries = allEntries.slice(batchStart, batchStart + BATCH_SIZE);
      const batchNumber = batchIndex + 1;

      console.log(
        `Processing round 2 batch ${batchNumber}/${totalBatches} with ${entries.length} entries`,
      );

      try {
        await processBatch(entries, promptTemplate);
      } catch (error) {
        console.error(`Error processing idiomacity round 2 batch ${batchNumber}:`, error);
        break;
      }
    }

    console.log('Idiomacity generation round 2 completed');
  } catch (error) {
    console.error('Fatal error in idiomacityGeneratorRound2:', error);
    throw error;
  }
}
