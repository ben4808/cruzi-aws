import fs from 'fs';
import { LanguageNames } from 'cruzi-models';
import { batchArray, entryToAllCaps, stripAccents } from '../lib/utils';
import { GeminiWebAiProvider } from './geminiWebProvider';
import { loadFamiliarityPromptAsync, parseFamiliarityResponse } from './common';

const SCORE_BATCH_SIZE = 40;
const MAX_BATCH_RETRIES = 5;

export interface ParsedIdiomacityResult {
  parsedForm: string;
  category: string;
  score: number;
}

export interface ParsedFamiliarityResult {
  entry: string;
  displayText: string;
  entryType: string;
  baseForm?: string;
  familiarityScore: number;
}

export interface ScoredPhrase {
  phrase: string;
  entryKey: string;
  displayText: string;
  entryType: string;
  rootEntry?: string;
  idiomacityScore: number;
  familiarityScore: number;
}

function isGeminiTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out/i.test(message);
}

async function withGeminiRetries<T>(label: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (isGeminiTimeoutError(error) && attempt < MAX_BATCH_RETRIES) {
        console.warn(`${label} (attempt ${attempt}/${MAX_BATCH_RETRIES}), retrying...`);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`${label} failed after ${MAX_BATCH_RETRIES} attempts`);
}

export async function loadIdiomacityPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/phrase_idiomacity_prompt.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading idiomacity prompt file:', err);
    throw err;
  }
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

function normalizeForPhraseMatch(text: string): string {
  return stripAccents(text).toLowerCase();
}

export function matchIdiomacityResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedIdiomacityResult[],
): Array<{ phrase: string; parsed: ParsedIdiomacityResult } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ phrase: string; parsed: ParsedIdiomacityResult } | null> = [];

  for (const phrase of phrases) {
    let matchIndex = unmatchedParsed.findIndex(
      (parsed) => normalizeForPhraseMatch(parsed.parsedForm) === normalizeForPhraseMatch(phrase),
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => entryToAllCaps(parsed.parsedForm) === entryToAllCaps(phrase),
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
    matches.push({ phrase, parsed });
  }

  return matches;
}

export function matchFamiliarityResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedFamiliarityResult[],
): Array<{ phrase: string; parsed: ParsedFamiliarityResult } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ phrase: string; parsed: ParsedFamiliarityResult } | null> = [];

  for (const phrase of phrases) {
    let matchIndex = unmatchedParsed.findIndex(
      (parsed) => entryToAllCaps(parsed.entry) === entryToAllCaps(phrase),
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => normalizeForPhraseMatch(parsed.displayText) === normalizeForPhraseMatch(phrase),
      );
    }

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => normalizeForPhraseMatch(parsed.entry) === normalizeForPhraseMatch(phrase),
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
    matches.push({ phrase, parsed });
  }

  return matches;
}

export async function scorePhrasesForIdiomacity(
  phrases: string[],
  provider: GeminiWebAiProvider,
): Promise<Map<string, ParsedIdiomacityResult>> {
  const promptTemplate = await loadIdiomacityPromptAsync();
  const resultsByPhrase = new Map<string, ParsedIdiomacityResult>();

  for (const batch of batchArray(phrases, SCORE_BATCH_SIZE)) {
    const promptData = batch.join('\n');
    const prompt = promptTemplate.replace('[[DATA]]', promptData);

    console.log(`Sending idiomacity prompt for ${batch.length} phrases`);
    const aiResponse = await withGeminiRetries('Idiomacity scoring', () =>
      provider.generateResultsAsync(prompt),
    );
    console.log(`Received idiomacity response (${aiResponse.length} characters)`);

    const parsedResults = parseIdiomacityResponse(aiResponse);
    const matches = matchIdiomacityResultsToPhrases(batch, parsedResults);

    for (const match of matches) {
      if (!match) {
        continue;
      }
      resultsByPhrase.set(match.phrase, match.parsed);
    }
  }

  return resultsByPhrase;
}

export async function scorePhrasesForFamiliarity(
  phrases: string[],
  lang: string,
  provider: GeminiWebAiProvider,
): Promise<Map<string, ParsedFamiliarityResult>> {
  const promptTemplate = await loadFamiliarityPromptAsync();
  const langName = LanguageNames[lang] ?? lang;
  const resultsByPhrase = new Map<string, ParsedFamiliarityResult>();

  for (const batch of batchArray(phrases, SCORE_BATCH_SIZE)) {
    const promptData = batch.map((phrase) => entryToAllCaps(phrase)).join('\n');
    const prompt = promptTemplate.replace(/\[\[LANG\]\]/g, langName).replace('[[DATA]]', promptData);

    console.log(`Sending familiarity prompt for ${batch.length} ${lang} phrases`);
    const aiResponse = await withGeminiRetries('Familiarity scoring', () =>
      provider.generateResultsAsync(prompt),
    );
    console.log(`Received familiarity response for ${lang} (${aiResponse.length} characters)`);

    const parsedResults = parseFamiliarityResponse(aiResponse) as ParsedFamiliarityResult[];
    const matches = matchFamiliarityResultsToPhrases(batch, parsedResults);

    for (const match of matches) {
      if (!match) {
        continue;
      }
      resultsByPhrase.set(match.phrase, match.parsed);
    }
  }

  return resultsByPhrase;
}

export function combinePhraseScores(
  phrases: string[],
  idiomacityByPhrase: Map<string, ParsedIdiomacityResult>,
  familiarityByPhrase: Map<string, ParsedFamiliarityResult>,
  minIdiomacityScore: number,
  minFamiliarityScore: number,
): ScoredPhrase[] {
  const minFamiliarityStored = Math.round(minFamiliarityScore * 10);
  const qualifying: ScoredPhrase[] = [];

  for (const phrase of phrases) {
    const idiomacity = idiomacityByPhrase.get(phrase);
    const familiarity = familiarityByPhrase.get(phrase);

    if (!idiomacity || !familiarity) {
      continue;
    }

    if (idiomacity.score < minIdiomacityScore) {
      continue;
    }

    if (familiarity.familiarityScore < minFamiliarityStored) {
      continue;
    }

    qualifying.push({
      phrase,
      entryKey: entryToAllCaps(familiarity.displayText),
      displayText: stripAccents(familiarity.displayText),
      entryType: familiarity.entryType,
      rootEntry: familiarity.baseForm,
      idiomacityScore: idiomacity.score,
      familiarityScore: familiarity.familiarityScore,
    });
  }

  return qualifying;
}
