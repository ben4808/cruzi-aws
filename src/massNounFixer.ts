/*
Keep looping through these steps:

Steps:
1. Select all senses from the sense table that 
  a. Have familiarity score of less than 50 and are Nouns. AND
  b. Are Primary senses.
  Batch them into batches of 100 in memory.
2. For each batch, populate mass_noun_prompt.txt and send the query to GeminiWebProvider (extended model).
3. For all results, delete all example sentences for that sense.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  deleteExampleSentencesForSenses,
  getPrimaryNounSensesLowFamiliarity,
  PrimaryNounSenseLowFamiliarity,
} from 'cruzi-db';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { batchArray, isGeminiTimeoutError } from './lib/utils';

const BATCH_SIZE = 100;
const extendedFlashProvider = new GeminiWebAiProvider('gemini-web-extended-flash');

async function loadMassNounPromptAsync(): Promise<string> {
  try {
    return await fs.promises.readFile('./src/ai/mass_noun_prompt.txt', 'utf-8');
  } catch (err) {
    console.error('Error reading mass noun prompt file:', err);
    throw err;
  }
}

function promptLineForSense(sense: PrimaryNounSenseLowFamiliarity): string {
  return `${sense.displayText} (${sense.senseSummary})`;
}

export function parseMassNounResponse(
  response: string,
): Array<{ displayText: string; senseSummary: string }> {
  const results: Array<{ displayText: string; senseSummary: string }> = [];
  const lines = response.split('\n').filter((line) => line.trim() !== '');

  for (const line of lines) {
    const trimmed = line.trim();
    const parenMatch = trimmed.match(/^(.+?) \((.+)\)$/);
    if (!parenMatch) {
      continue;
    }

    results.push({
      displayText: parenMatch[1].trim(),
      senseSummary: parenMatch[2].trim(),
    });
  }

  return results;
}

function matchMassNounResultsToSenses(
  senses: PrimaryNounSenseLowFamiliarity[],
  parsedResults: Array<{ displayText: string; senseSummary: string }>,
): PrimaryNounSenseLowFamiliarity[] {
  const unmatchedParsed = [...parsedResults];
  const matchedSenses: PrimaryNounSenseLowFamiliarity[] = [];

  for (const sense of senses) {
    const promptLine = promptLineForSense(sense);

    let matchIndex = unmatchedParsed.findIndex(
      (parsed) => `${parsed.displayText} (${parsed.senseSummary})` === promptLine,
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) =>
          parsed.displayText === sense.displayText && parsed.senseSummary === sense.senseSummary,
      );
    }

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) =>
          parsed.displayText.toLowerCase() === sense.displayText.toLowerCase() &&
          parsed.senseSummary.toLowerCase() === sense.senseSummary.toLowerCase(),
      );
    }

    if (matchIndex === -1) {
      continue;
    }

    const [parsed] = unmatchedParsed.splice(matchIndex, 1);
    matchedSenses.push(sense);
    console.log(
      `  Mass noun: ${parsed.displayText} (${parsed.senseSummary}) [${sense.senseId}]`,
    );
  }

  return matchedSenses;
}

async function processBatch(
  senses: PrimaryNounSenseLowFamiliarity[],
  promptTemplate: string,
): Promise<number> {
  const promptData = senses.map((sense) => promptLineForSense(sense)).join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending mass noun prompt for ${senses.length} senses`);
  const aiResponse = await extendedFlashProvider.generateResultsAsync(prompt);
  console.log(`Received mass noun response (${aiResponse.length} characters)`);

  const parsedResults = parseMassNounResponse(aiResponse);
  console.log(`Parsed ${parsedResults.length} mass noun results from response`);

  const massNounSenses = matchMassNounResultsToSenses(senses, parsedResults);
  console.log(`Matched ${massNounSenses.length}/${senses.length} senses as mass nouns`);

  if (massNounSenses.length === 0) {
    return 0;
  }

  const deletedCount = await deleteExampleSentencesForSenses(
    massNounSenses.map((sense) => sense.senseId),
  );
  console.log(
    `Deleted ${deletedCount} example sentences for ${massNounSenses.length} mass noun senses`,
  );

  return massNounSenses.length;
}

export async function massNounFixer(): Promise<void> {
  try {
    console.log('Starting mass noun fixer...');

    const senses = await getPrimaryNounSensesLowFamiliarity();
    if (senses.length === 0) {
      console.log('No primary noun senses found with familiarity score below 50');
      return;
    }

    console.log(
      `Found ${senses.length} primary noun senses with familiarity score below 50`,
    );

    const promptTemplate = await loadMassNounPromptAsync();
    const batches = batchArray(senses, BATCH_SIZE);
    let totalMassNouns = 0;

    for (let batchNumber = 0; batchNumber < batches.length; batchNumber++) {
      const batch = batches[batchNumber];
      console.log(
        `Processing batch ${batchNumber + 1}/${batches.length} (${batch.length} senses)`,
      );

      try {
        totalMassNouns += await processBatch(batch, promptTemplate);
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing mass noun batch ${batchNumber + 1}`);
          break;
        }

        console.error(`Error processing mass noun batch ${batchNumber + 1}:`, error);
        break;
      }
    }

    console.log(
      `Mass noun fixer completed: ${totalMassNouns} mass noun senses found across ${senses.length} senses`,
    );
  } catch (error) {
    console.error('Fatal error in massNounFixer:', error);
    throw error;
  }
}
