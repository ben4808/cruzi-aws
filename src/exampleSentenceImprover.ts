/*
Keep looping through the following steps:
1. Select 20 random example sentences from the example_sentence table that do not already
    have an entry in the example_sentence_improvement table.
2. Generate a prompt using example_sentences_improver.txt and send it to the Gemini 
   (using GeminiWebAiProvider extended mode). Each input line is "<display_text> (<part of speech>, <sense summary>): <sentence>".
3. Save the results into the example_sentence_improvement table.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  addExampleSentenceImprovement,
  getRandomExampleSentencesTop20,
  RandomExampleSentence,
} from 'cruzi-db';
import { GeminiWebAiProvider } from './ai/geminiWebProvider';
import { isGeminiTimeoutError } from './lib/utils';

const extendedFlashProvider = new GeminiWebAiProvider('gemini-web-extended-flash');

async function loadExampleSentencesImproverPromptAsync(): Promise<string> {
  try {
    return await fs.promises.readFile('./src/ai/example_sentences_improver.txt', 'utf-8');
  } catch (err) {
    console.error('Error reading example sentences improver prompt file:', err);
    throw err;
  }
}

function promptLineForExampleSentence(sentence: RandomExampleSentence): string {
  const pos = sentence.partOfSpeech.trim();
  const senseLabel = pos ? `${pos}, ${sentence.senseSummary}` : sentence.senseSummary;
  return `${sentence.displayText} (${senseLabel}): ${sentence.sentenceEn}`;
}

interface ParsedImprovementResult {
  noImprovement: boolean;
  wordPhrase?: string;
  sense?: string;
  worstSentence?: string;
  newSentenceEn?: string;
  newSentenceEs?: string;
}

function extractSummarySection(response: string): string | null {
  const marker = 'WORST SENTENCE';
  const idx = response.lastIndexOf(marker);
  if (idx === -1) {
    return null;
  }

  return response.slice(idx);
}

function parseImprovementResponse(response: string): ParsedImprovementResult | null {
  if (/no improvement suggested/i.test(response)) {
    return { noImprovement: true };
  }

  const summary = extractSummarySection(response);
  if (!summary) {
    return null;
  }

  const lines = summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const worstSentenceIdx = lines.findIndex((line) => line === 'WORST SENTENCE');
  const replacementIdx = lines.findIndex((line) => line === 'RECOMMENDED REPLACEMENT');

  if (worstSentenceIdx === -1 || replacementIdx === -1 || replacementIdx <= worstSentenceIdx + 1) {
    return null;
  }

  const worstSentenceLine = lines[worstSentenceIdx + 1];
  const worstSentenceMatch = worstSentenceLine.match(/^(.+?) \((.+)\): (.+)$/);
  if (!worstSentenceMatch) {
    return null;
  }

  const newSentenceEn = lines[replacementIdx + 1];
  const newSentenceEs = lines[replacementIdx + 2];

  if (!newSentenceEn || !newSentenceEs) {
    return null;
  }

  return {
    noImprovement: false,
    wordPhrase: worstSentenceMatch[1].trim(),
    sense: worstSentenceMatch[2].trim(),
    worstSentence: worstSentenceMatch[3].trim(),
    newSentenceEn,
    newSentenceEs,
  };
}

function normalizeSentenceText(sentence: string): string {
  return sentence.replace(/\{\{|\}\}/g, '').trim().toLowerCase();
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function matchImprovementToExampleSentence(
  sentences: RandomExampleSentence[],
  parsed: ParsedImprovementResult,
): RandomExampleSentence | null {
  if (!parsed.worstSentence) {
    return null;
  }

  const normalizedWorstSentence = normalizeSentenceText(parsed.worstSentence);
  const normalizedWordPhrase = parsed.wordPhrase ? normalizeLabel(parsed.wordPhrase) : '';
  const normalizedSense = parsed.sense ? normalizeLabel(parsed.sense) : '';

  const sentenceMatch = sentences.find(
    (sentence) => normalizeSentenceText(sentence.sentenceEn) === normalizedWorstSentence,
  );
  if (sentenceMatch) {
    return sentenceMatch;
  }

  if (normalizedWordPhrase) {
    const wordPhraseMatches = sentences.filter(
      (sentence) => normalizeLabel(sentence.displayText) === normalizedWordPhrase,
    );

    if (wordPhraseMatches.length === 1) {
      return wordPhraseMatches[0];
    }

    if (normalizedSense && wordPhraseMatches.length > 0) {
      const senseMatch = wordPhraseMatches.find((sentence) => {
        const pos = sentence.partOfSpeech.trim();
        const senseLabel = pos ? `${pos}, ${sentence.senseSummary}` : sentence.senseSummary;
        return normalizeLabel(senseLabel) === normalizedSense
          || normalizeLabel(sentence.senseSummary) === normalizedSense;
      });
      if (senseMatch) {
        return senseMatch;
      }
    }
  }

  return null;
}

async function processBatch(
  sentences: RandomExampleSentence[],
  promptTemplate: string,
): Promise<number> {
  const dataLines = sentences.map((sentence) => promptLineForExampleSentence(sentence)).join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', dataLines);

  const aiResponse = await extendedFlashProvider.generateResultsAsync(prompt);
  console.log(`Received example sentence improvement response (${aiResponse.length} characters)`);

  const parsed = parseImprovementResponse(aiResponse);
  if (!parsed) {
    console.warn('Failed to parse example sentence improvement response; skipping batch');
    return 0;
  }

  if (parsed.noImprovement) {
    console.log('AI reported no improvement suggested for this batch');
    return 0;
  }

  const matchedSentence = matchImprovementToExampleSentence(sentences, parsed);
  if (!matchedSentence) {
    console.warn('Failed to match improvement result to an example sentence; skipping batch');
    return 0;
  }

  await addExampleSentenceImprovement({
    exampleSentenceId: matchedSentence.exampleSentenceId,
    oldSentence: matchedSentence.sentenceEn,
    newSentence: parsed.newSentenceEn!,
    newTranslation: parsed.newSentenceEs!,
  });

  console.log(
    `Saved improvement for example sentence ${matchedSentence.exampleSentenceId} (${matchedSentence.displayText})`,
  );
  return 1;
}

export async function exampleSentenceImprover(): Promise<void> {
  try {
    console.log('Starting example sentence improvement...');

    const promptTemplate = await loadExampleSentencesImproverPromptAsync();
    let batchNumber = 0;
    let totalSaved = 0;

    while (true) {
      const sentences = await getRandomExampleSentencesTop20();
      if (sentences.length === 0) {
        console.log('No example sentences remaining that need improvement review');
        break;
      }

      batchNumber++;
      console.log(`Processing batch ${batchNumber} with ${sentences.length} example sentences`);

      try {
        const savedCount = await processBatch(sentences, promptTemplate);
        totalSaved += savedCount;
      } catch (error) {
        if (isGeminiTimeoutError(error)) {
          console.warn(`Gemini timeout processing example sentence improvement batch ${batchNumber}`);
          break;
        }

        console.error(`Error processing example sentence improvement batch ${batchNumber}:`, error);
        break;
      }
    }

    console.log(`Example sentence improvement completed (${totalSaved} improvements saved)`);
  } catch (error) {
    console.error('Fatal error in exampleSentenceImprover:', error);
    throw error;
  }
}
