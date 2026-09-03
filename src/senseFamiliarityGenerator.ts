/*
Keep looping through the following steps:
1. Select the first 50 senses from the sense table that do not have a familiarity score.
2. For each sense, generate a prompt using the sense_familiarity_prompt.txt file. Send the prompt to Gemini (using GeminiWebAiProvider standard mode)
   and get the response. Input on each lines should be "<display_text> (<sense summary>)".
3. Update the familiarity_score field for each sense with the returned score * 10 to fit in an integer column.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getSensesWithoutFamiliarityTop50,
  updateSenseFamiliarityScores,
  SenseWithoutFamiliarity,
} from 'cruzi-db';
import { LanguageNames } from 'cruzi-models';
import { loadSenseFamiliarityPromptAsync, parseSenseFamiliarityResponse } from './ai/common';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { matchParsedResultsByIdentity } from './lib/resultMatching';
import { isGeminiTimeoutError } from './lib/utils';

const geminiProvider = new GeminiWebAiProvider();

function promptLineForSense(sense: SenseWithoutFamiliarity): string {
  return `${sense.displayText} (${sense.senseSummary})`;
}

function groupSensesByLang(
  senses: SenseWithoutFamiliarity[],
): Map<string, SenseWithoutFamiliarity[]> {
  const byLang = new Map<string, SenseWithoutFamiliarity[]>();
  for (const sense of senses) {
    const items = byLang.get(sense.lang) ?? [];
    items.push(sense);
    byLang.set(sense.lang, items);
  }
  return byLang;
}

function matchParsedResultsToSenses(
  senses: SenseWithoutFamiliarity[],
  parsedResults: ReturnType<typeof parseSenseFamiliarityResponse>,
): Array<{ sense: SenseWithoutFamiliarity; parsed: (typeof parsedResults)[number] } | null> {
  return matchParsedResultsByIdentity(
    senses,
    parsedResults,
    (sense) => [promptLineForSense(sense)],
    (parsed) => [`${parsed.displayText} (${parsed.summary})`],
  ).map((match) => (match ? { sense: match.input, parsed: match.parsed } : null));
}

async function processLangGroup(
  senses: SenseWithoutFamiliarity[],
  promptTemplate: string,
): Promise<void> {
  const lang = senses[0].lang;
  const langName = LanguageNames[lang] ?? lang;
  const promptData = senses.map((sense) => promptLineForSense(sense)).join('\n');
  const prompt = promptTemplate.replace(/\[\[LANG\]\]/g, langName).replace('[[DATA]]', promptData);

  console.log(`Sending sense familiarity prompt for ${senses.length} ${lang} senses`);
  const aiResponse = await geminiProvider.generateResultsAsync(prompt);
  console.log(`Received sense familiarity response for ${lang} batch (${aiResponse.length} characters)`);

  const parsedResults = parseSenseFamiliarityResponse(aiResponse);
  console.log(`Parsed ${parsedResults.length} sense familiarity results from ${lang} response`);

  if (parsedResults.length === 0) {
    console.warn(`No sense familiarity results parsed for ${lang}; skipping batch update`);
    return;
  }

  if (parsedResults.length !== senses.length) {
    console.warn(
      `Expected ${senses.length} sense familiarity results for ${lang} but parsed ${parsedResults.length}`,
    );
  }

  const matches = matchParsedResultsToSenses(senses, parsedResults);
  const resultsToPersist: Array<{ senseId: string; familiarityScore: number }> = [];

  for (const match of matches) {
    if (!match) {
      continue;
    }

    const { sense, parsed } = match;
    resultsToPersist.push({
      senseId: sense.senseId,
      familiarityScore: parsed.familiarityScore,
    });

    console.log(
      `Processed ${sense.displayText} (${sense.senseSummary}) [${sense.senseId}]: score=${parsed.familiarityScore / 10}`,
    );
  }

  if (resultsToPersist.length > 0) {
    await updateSenseFamiliarityScores(resultsToPersist);
    console.log(`Updated familiarity scores for ${resultsToPersist.length} ${lang} senses`);
  }
}

async function processBatch(
  senses: SenseWithoutFamiliarity[],
  promptTemplate: string,
): Promise<void> {
  const sensesByLang = groupSensesByLang(senses);

  for (const [, langSenses] of sensesByLang.entries()) {
    await processLangGroup(langSenses, promptTemplate);
  }
}

export async function senseFamiliarityGenerator(): Promise<void> {
  try {
    console.log('Starting sense familiarity generation...');

    const promptTemplate = await loadSenseFamiliarityPromptAsync();
    let batchNumber = 0;

    while (true) {
      const senses = await getSensesWithoutFamiliarityTop50();
      if (senses.length === 0) {
        console.log('No senses remaining without familiarity scores');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${senses.length} senses`);

      try {
        await processBatch(senses, promptTemplate);
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing sense familiarity batch ${batchNumber}`);
          break;
        }

        console.error(`Error processing sense familiarity batch ${batchNumber}:`, error);
        break;
      }
    }
  } catch (error) {
    console.error('Fatal error in senseFamiliarityGenerator:', error);
    throw error;
  }
}
