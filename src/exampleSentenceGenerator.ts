/**
Keep looping through the following steps:
1. Query the database for the top 10 records in the sense table that:
  - have no example_sentences record and
  - either are a Primary sense or have a familiarity score of 50

2. Using the prompt in example_sentences_prompt.txt, send a request to the Gemini (using GeminiWebAiProvider standard mode).
   Each input line is "<display_text> (<sense summary>)". The model returns at least 3 English/Spanish sentence pairs per item,
   with the target word/phrase highlighted via {{double brackets}} in the English sentence.
3. Update the database with the example sentences returned.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
 */

import fs from 'fs';
import {
  getSensesWithoutExampleSentencesTop10,
  addExampleSentences,
  SenseWithoutExampleSentences,
} from 'cruzi-db';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { isGeminiTimeoutError } from './lib/utils';
import { ExampleSentence } from 'cruzi-models';

const geminiProvider = new GeminiWebAiProvider();

async function loadExampleSentencesPromptAsync(): Promise<string> {
  try {
    const content: string = await fs.promises.readFile('./src/ai/example_sentences_prompt.txt', 'utf-8');
    return content;
  } catch (err) {
    console.error('Error reading example sentences prompt file:', err);
    throw err;
  }
}

interface ParsedExampleSentences {
  wordPhrase: string;
  sentences: Array<{
    english: string;
    spanish: string;
  }>;
}

function promptLineForSense(sense: SenseWithoutExampleSentences): string {
  return `${sense.displayText} (${sense.senseSummary})`;
}

const MIN_SENTENCE_PAIRS = 3;

function parseExampleSentencesBatchResponse(response: string): ParsedExampleSentences[] {
  const lines = response.split('\n');
  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const line of lines) {
    if (line.trim() === '') {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
    } else {
      currentBlock.push(line);
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  const parsedResults: ParsedExampleSentences[] = [];

  for (const block of blocks) {
    const filteredLines = block.filter((line) => line.trim() !== '');
    if (filteredLines.length === 0) {
      continue;
    }

    const wordPhrase = filteredLines[0].trim();
    const sentences: Array<{ english: string; spanish: string }> = [];

    for (let i = 1; i < filteredLines.length; i += 2) {
      if (i + 1 < filteredLines.length) {
        sentences.push({
          english: filteredLines[i].trim(),
          spanish: filteredLines[i + 1].trim(),
        });
      }
    }

    if (sentences.length < MIN_SENTENCE_PAIRS) {
      console.warn(`Expected at least ${MIN_SENTENCE_PAIRS} sentence pairs but got ${sentences.length} for ${wordPhrase}`);
      continue;
    }

    parsedResults.push({ wordPhrase, sentences });
  }

  return parsedResults;
}

function createExampleSentencesFromParsedData(parsedData: ParsedExampleSentences): ExampleSentence[] {
  return parsedData.sentences.map((sentence) => ({
    senseId: '',
    translations: {
      en: sentence.english,
      es: sentence.spanish,
    },
  }));
}

function normalizeWordPhrase(wordPhrase: string): string {
  return wordPhrase.trim().toLowerCase();
}

function matchParsedResultToSense(
  sense: SenseWithoutExampleSentences,
  parsedResults: ParsedExampleSentences[],
): ParsedExampleSentences | null {
  const promptLine = promptLineForSense(sense);
  const normalizedPromptLine = normalizeWordPhrase(promptLine);
  const normalizedDisplayText = normalizeWordPhrase(sense.displayText);

  let matchIndex = parsedResults.findIndex(
    (parsed) => normalizeWordPhrase(parsed.wordPhrase) === normalizedPromptLine,
  );
  if (matchIndex === -1) {
    matchIndex = parsedResults.findIndex(
      (parsed) => normalizeWordPhrase(parsed.wordPhrase) === normalizedDisplayText,
    );
  }
  if (matchIndex === -1) {
    matchIndex = parsedResults.findIndex((parsed) =>
      normalizeWordPhrase(parsed.wordPhrase).startsWith(`${normalizedDisplayText} (`),
    );
  }
  if (matchIndex === -1) {
    matchIndex = parsedResults.findIndex((parsed) =>
      normalizeWordPhrase(parsed.wordPhrase).startsWith(normalizedDisplayText),
    );
  }

  if (matchIndex === -1) {
    return null;
  }

  const [parsed] = parsedResults.splice(matchIndex, 1);
  return parsed;
}

async function processBatch(
  senses: SenseWithoutExampleSentences[],
  promptTemplate: string,
): Promise<number> {
  const wordPhraseEntries = senses.map((sense) => promptLineForSense(sense)).join('\n');
  const prompt = promptTemplate.replace('[[WORDS AND PHRASES]]', wordPhraseEntries);

  const aiResponse = await geminiProvider.generateResultsAsync(prompt);
  console.log(`Received example sentence response (${aiResponse.length} characters)`);

  const parsedResults = parseExampleSentencesBatchResponse(aiResponse);
  console.log(`Parsed ${parsedResults.length} example sentence results`);

  if (parsedResults.length === 0) {
    console.warn('No example sentence results parsed; skipping batch update');
    return 0;
  }

  const unmatchedParsed = [...parsedResults];
  let savedCount = 0;

  for (const sense of senses) {
    const parsedData = matchParsedResultToSense(sense, unmatchedParsed);
    if (!parsedData) {
      console.warn(`Failed to match example sentences for sense ${sense.senseId} (${sense.displayText})`);
      continue;
    }

    const exampleSentences = createExampleSentencesFromParsedData(parsedData);
    await addExampleSentences(sense.senseId, exampleSentences);
    savedCount++;
    console.log(`Saved ${exampleSentences.length} example sentences for sense ${sense.senseId} (${sense.displayText})`);
  }

  return savedCount;
}

export async function exampleSentenceGenerator(): Promise<void> {
  try {
    console.log('Starting example sentence generation...');

    const promptTemplate = await loadExampleSentencesPromptAsync();
    let batchNumber = 0;

    while (true) {
      const senses = await getSensesWithoutExampleSentencesTop10();
      if (senses.length === 0) {
        console.log('No senses remaining that need example sentences');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${senses.length} senses`);

      try {
        const savedCount = await processBatch(senses, promptTemplate);
        if (savedCount === 0) {
          console.warn(`No example sentences saved in batch ${batchNumber}; stopping`);
          break;
        }
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing example sentence batch ${batchNumber}`);
          break;
        }

        console.error(`Error processing example sentence batch ${batchNumber}:`, error);
        break;
      }
    }

    console.log('Example sentence generation completed');
  } catch (error) {
    console.error('Fatal error in exampleSentenceGenerator:', error);
    throw error;
  }
}
