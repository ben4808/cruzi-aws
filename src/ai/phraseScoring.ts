import fs from 'fs';
import { LanguageNames } from 'cruzi-models';
import { entryToAllCaps, stripAccents } from '../lib/utils';
import { GeminiWebAiProvider } from './geminiWebProvider';
import { loadFamiliarityPromptAsync, parseFamiliarityResponse } from './common';

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

export async function loadIdiomacityPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/phrase_idiomacity_prompt.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading idiomacity prompt file:', err);
    throw err;
  }
}

async function loadPhraseGeneratorIdiomacityPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/phrase_idiomacity_prompt_2.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading phrase generator idiomacity prompt file:', err);
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

function parsePhraseGeneratorIdiomacityResponse(response: string): ParsedIdiomacityResult[] {
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
  const resultsByPhrase = new Map<string, ParsedIdiomacityResult>();
  if (phrases.length === 0) {
    return resultsByPhrase;
  }

  const promptTemplate = await loadPhraseGeneratorIdiomacityPromptAsync();
  const promptData = phrases.join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending idiomacity prompt for ${phrases.length} phrases`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received idiomacity response (${aiResponse.length} characters)`);

  const parsedResults = parsePhraseGeneratorIdiomacityResponse(aiResponse);
  const matches = matchIdiomacityResultsToPhrases(phrases, parsedResults);

  for (const match of matches) {
    if (!match) {
      continue;
    }
    resultsByPhrase.set(match.phrase, match.parsed);
  }

  return resultsByPhrase;
}

export async function scorePhrasesForFamiliarity(
  phrases: string[],
  lang: string,
  provider: GeminiWebAiProvider,
): Promise<Map<string, ParsedFamiliarityResult>> {
  const resultsByPhrase = new Map<string, ParsedFamiliarityResult>();
  if (phrases.length === 0) {
    return resultsByPhrase;
  }

  const promptTemplate = await loadFamiliarityPromptAsync();
  const langName = LanguageNames[lang] ?? lang;
  const promptData = phrases.map((phrase) => entryToAllCaps(phrase)).join('\n');
  const prompt = promptTemplate.replace(/\[\[LANG\]\]/g, langName).replace('[[DATA]]', promptData);

  console.log(`Sending familiarity prompt for ${phrases.length} ${lang} phrases`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received familiarity response for ${lang} (${aiResponse.length} characters)`);

  const parsedResults = parseFamiliarityResponse(aiResponse) as ParsedFamiliarityResult[];
  const matches = matchFamiliarityResultsToPhrases(phrases, parsedResults);

  for (const match of matches) {
    if (!match) {
      continue;
    }
    resultsByPhrase.set(match.phrase, match.parsed);
  }

  return resultsByPhrase;
}

function combinedScore(item: ScoredPhrase): number {
  return item.idiomacityScore + item.familiarityScore / 10;
}

export function dedupeScoredPhrasesByEntryKey(phrases: ScoredPhrase[]): ScoredPhrase[] {
  const byEntryKey = new Map<string, ScoredPhrase>();

  for (const item of phrases) {
    const existing = byEntryKey.get(item.entryKey);
    if (!existing || combinedScore(item) > combinedScore(existing)) {
      byEntryKey.set(item.entryKey, item);
    }
  }

  const deduped = [...byEntryKey.values()];
  const collapsed = phrases.length - deduped.length;
  if (collapsed > 0) {
    console.log(
      `Collapsed ${collapsed} qualifying phrases that mapped to duplicate entry keys`,
    );
  }

  return deduped;
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

  return dedupeScoredPhrasesByEntryKey(qualifying);
}
