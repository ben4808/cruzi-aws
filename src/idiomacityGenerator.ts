/*
Keep looping through the following steps:
1. Select the first 50 entries from the entry table that do not have an idiomacity score.
2. For each entry, generate a prompt using the phrase_idiomacity_prompt.txt file. Send the prompt to Gemini 
   and get the response.
3. Update a few fields in the entry table with the results:
    - idiomacity_score
    - if display_text was null, set it to the parsed form in the response
    - if entry_type was null, set it to the parsed category in the response
4. If the parsed category is Word, add a couple of items to the phrase_generator_queue table:
    - <entry> ____
    - ____ <entry>

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
*/

import fs from 'fs';
import {
  getEntriesWithoutIdiomacityTop50,
  updateEntryIdiomacityResults,
  addPhraseGeneratorQueueEntries,
  EntryWithoutIdiomacity,
  EntryIdiomacityResult,
  PhraseGeneratorQueueItem,
} from 'cruzi-db';
import { entryToAllCaps, stripAccents } from './lib/utils';
import { GeminiAiProvider } from './ai/gemini';

const geminiProvider = new GeminiAiProvider();

async function loadIdiomacityPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/phrase_idiomacity_prompt.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading idiomacity prompt file:', err);
    throw err;
  }
}

export interface ParsedIdiomacityResult {
  parsedForm: string;
  category: string;
  score: number;
}

export function parseIdiomacityResponse(response: string): ParsedIdiomacityResult[] {
  const summaryIndex = response.indexOf('SUMMARY:');
  if (summaryIndex === -1) {
    return [];
  }

  const summaryText = response.slice(summaryIndex + 'SUMMARY:'.length);
  const lines = summaryText.split('\n').map((line) => line.trim()).filter((line) => line !== '');

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

function getPromptText(item: EntryWithoutIdiomacity): string {
  return item.display_text ?? item.entry;
}

function normalizeForEntryMatch(text: string): string {
  return entryToAllCaps(stripAccents(text));
}

function matchParsedResultsToEntries(
  entries: EntryWithoutIdiomacity[],
  parsedResults: ParsedIdiomacityResult[],
): Array<{ entry: EntryWithoutIdiomacity; parsed: ParsedIdiomacityResult } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ entry: EntryWithoutIdiomacity; parsed: ParsedIdiomacityResult } | null> = [];

  for (const entryItem of entries) {
    const promptText = getPromptText(entryItem);
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
        (parsed) => parsed.parsedForm.toLowerCase() === promptText.toLowerCase(),
      );
    }

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) =>
          stripAccents(parsed.parsedForm).toLowerCase() === stripAccents(promptText).toLowerCase(),
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

async function processBatch(
  entries: EntryWithoutIdiomacity[],
  promptTemplate: string,
): Promise<void> {
  const promptData = entries.map(getPromptText).join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending idiomacity prompt for ${entries.length} entries`);
  const aiResponse = await geminiProvider.generateResultsAsync(prompt);
  console.log(`Received idiomacity response for batch (${aiResponse.length} characters)`);

  const parsedResults = parseIdiomacityResponse(aiResponse);
  console.log(`Parsed ${parsedResults.length} idiomacity results from response`);

  if (parsedResults.length === 0) {
    console.warn('No idiomacity results parsed; skipping batch update');
    return;
  }

  if (parsedResults.length !== entries.length) {
    console.warn(
      `Expected ${entries.length} idiomacity results but parsed ${parsedResults.length}`,
    );
  }

  const matches = matchParsedResultsToEntries(entries, parsedResults);
  const resultsToPersist: EntryIdiomacityResult[] = [];
  const phraseQueueItems: PhraseGeneratorQueueItem[] = [];

  for (const match of matches) {
    if (!match) {
      continue;
    }

    const { entry: entryItem, parsed } = match;
    const result: EntryIdiomacityResult = {
      entry: entryItem.entry,
      lang: entryItem.lang,
      idiomacityScore: parsed.score,
    };

    if (entryItem.display_text == null) {
      result.displayText = parsed.parsedForm;
    }

    if (entryItem.entry_type == null) {
      result.entryType = parsed.category;
    }

    resultsToPersist.push(result);

    const displayForQueue = entryItem.display_text ?? parsed.parsedForm;
    if (parsed.category.toLowerCase() === 'word') {
      phraseQueueItems.push(
        { prompt: `${displayForQueue} ____`, lang: entryItem.lang },
        { prompt: `____ ${displayForQueue}`, lang: entryItem.lang },
      );
    }

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): score=${parsed.score}, category=${parsed.category}, form=${parsed.parsedForm}`,
    );
  }

  if (resultsToPersist.length > 0) {
    await updateEntryIdiomacityResults(resultsToPersist);
    console.log(`Updated idiomacity fields for ${resultsToPersist.length} entries`);
  }

  if (phraseQueueItems.length > 0) {
    await addPhraseGeneratorQueueEntries(phraseQueueItems);
    console.log(`Queued ${phraseQueueItems.length} phrase generator prompts`);
  }
}

export async function idiomacityGenerator(): Promise<void> {
  try {
    console.log('Starting idiomacity generation...');

    const promptTemplate = await loadIdiomacityPromptAsync();
    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesWithoutIdiomacityTop50();
      if (entries.length === 0) {
        console.log('No entries remaining without idiomacity scores');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${entries.length} entries`);

      try {
        await processBatch(entries, promptTemplate);
      } catch (error) {
        console.error(`Error processing idiomacity batch ${batchNumber}:`, error);
      }
    }

    console.log('Idiomacity generation completed');
  } catch (error) {
    console.error('Fatal error in idiomacityGenerator:', error);
    throw error;
  }
}
