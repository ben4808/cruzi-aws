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

import {
  getEntriesWithoutIdiomacityTop50,
  upsertEntries,
  addPhraseGeneratorQueueEntries,
  EntryWithoutIdiomacity,
  PhraseGeneratorQueueItem,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import {
  getRunPhaseDeadline,
  isGeminiTimeoutError,
  isRunPhaseActive,
  pauseBetweenRunPhases,
} from './lib/runPauseCycle';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import {
  loadIdiomacityPromptAsync,
  matchIdiomacityResultsToPhrases,
  parseIdiomacityResponse,
  ParsedIdiomacityResult,
} from './ai/phraseScoring';

export type { ParsedIdiomacityResult };
export { parseIdiomacityResponse };

const geminiProvider = new GeminiWebAiProvider();

function getPromptText(item: EntryWithoutIdiomacity): string {
  return item.display_text ?? item.entry;
}

function matchParsedResultsToEntries(
  entries: EntryWithoutIdiomacity[],
  parsedResults: ParsedIdiomacityResult[],
): Array<{ entry: EntryWithoutIdiomacity; parsed: ParsedIdiomacityResult } | null> {
  const phrases = entries.map(getPromptText);
  const phraseMatches = matchIdiomacityResultsToPhrases(phrases, parsedResults);

  return phraseMatches.map((match, index) => {
    if (!match) {
      return null;
    }
    return { entry: entries[index], parsed: match.parsed };
  });
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
  const resultsToPersist: Entry[] = [];
  const phraseQueueItems: PhraseGeneratorQueueItem[] = [];

  for (const match of matches) {
    if (!match) {
      continue;
    }

    const { entry: entryItem, parsed } = match;
    const result: Entry = {
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
    await upsertEntries(resultsToPersist);
    console.log(`Updated idiomacity fields for ${resultsToPersist.length} entries`);
  }

  if (phraseQueueItems.length > 0) {
    await addPhraseGeneratorQueueEntries(phraseQueueItems);
    console.log(`Queued ${phraseQueueItems.length} phrase generator prompts`);
  }
}

export async function idiomacityGenerator(): Promise<void> {
  try {
    console.log('Starting idiomacity generation (2h run / 2h pause cycle)...');

    const promptTemplate = await loadIdiomacityPromptAsync();
    let batchNumber = 0;

    while (true) {
      const runDeadline = getRunPhaseDeadline();
      console.log('Starting idiomacity run phase (2 hours)...');

      while (isRunPhaseActive(runDeadline)) {
        const entries = await getEntriesWithoutIdiomacityTop50();
        if (entries.length === 0) {
          console.log('No entries remaining without idiomacity scores; ending run phase early');
          break;
        }

        batchNumber++;
        console.log(`Processing batch ${batchNumber} with ${entries.length} entries`);

        try {
          await processBatch(entries, promptTemplate);
        } catch (error) {
          if (isGeminiTimeoutError(error)) {
            console.warn(
              `Gemini timeout processing idiomacity batch ${batchNumber}; ending run phase for 1 hour pause...`,
            );
            break;
          }

          console.error(`Error processing idiomacity batch ${batchNumber}:`, error);
          break;
        }
      }

      await pauseBetweenRunPhases('Idiomacity generator');
    }
  } catch (error) {
    console.error('Fatal error in idiomacityGenerator:', error);
    throw error;
  }
}
