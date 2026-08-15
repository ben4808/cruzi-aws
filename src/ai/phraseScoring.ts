import fs from 'fs';
import { LanguageNames } from 'cruzi-models';
import { entryToAllCaps, stripAccents } from '../lib/utils';
import { GeminiWebAiProvider } from './geminiWebProvider';
import { IAiProvider } from './IAiProvider';
import { loadFamiliarityPromptAsync, parseFamiliarityResponse } from './common';

export interface ParsedIdiomacityResult {
  parsedForm: string;
  category: string;
  score: number;
}

export interface ParsedUnityBucketResult {
  parsedForm: string;
  bucket: string;
}

export interface ParsedEntryParserResult {
  entry: string;
  entryType: string;
  displayText: string;
  baseForm?: string;
}

export interface ParsedStrictDomainNamesResult {
  entry: string;
  step2NaturalForm: string;
  displayText: string;
}

const ENTRY_PARSER_CATEGORIES = new Set([
  'Word',
  'Inflected Word',
  'Phrase',
  'Inflected Phrase',
  'Proper Name',
  'Acronym/Abbreviation',
  'Prefix/Suffix',
  'Nonsense',
]);

export interface ParsedFamiliarityResult {
  entry: string;
  displayText: string;
  entryType: string;
  baseForm?: string;
  familiarityScore: number;
}

export interface ParsedAvailabilityResult {
  phrase: string;
  tier: string;
  familiarityScore: number;
}

export interface ParsedSpokenFamiliarityResult {
  phrase: string;
  familiarityScore: number;
}

const AVAILABILITY_TIER_SCORES: Record<string, number> = {
  'Tier 1': 50,
  'Tier 2+': 45,
  'Tier 2-': 40,
  'Tier 3+': 35,
  'Tier 3-': 30,
  'Tier 4+': 25,
  'Tier 4-': 20,
  'Tier 5+': 15,
  'Tier 5-': 10,
};

const UNITY_BUCKETS = new Set([
  'Concept',
  'Collocation',
  'Formula',
  'Non-unit',
  'Nonsense',
]);

const FAMILIARITY_BUCKETS = new Set([
  'Easy Collocation',
  'Beginner Core',
  'Ubiquitous',
  'Active',
  'General Knowledge',
  'Inferred',
  'Niche',
  'Obscure',
  'Barely Exists',
  'Nonsense',
]);

export interface ParsedFamiliarityBucketResult {
  parsedForm: string;
  bucket: string;
}

export interface ScoredPhrase {
  phrase: string;
  entryKey: string;
  displayText: string;
  entryType: string;
  baseForm?: string;
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

async function loadUnityPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/unity_prompt.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading unity prompt file:', err);
    throw err;
  }
}

export async function loadUnityBucketPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/unity_prompt_2.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading unity bucket prompt file:', err);
    throw err;
  }
}

export async function loadUnityBucketPrompt3Async(): Promise<string> {
  try {
    const promptPath = './src/ai/unity_prompt_3.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading unity bucket prompt 3 file:', err);
    throw err;
  }
}

export async function loadEntryParserPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/entry_parser_prompt.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading entry parser prompt file:', err);
    throw err;
  }
}

export async function loadStrictDomainNamesPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/strict_domain_names.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading strict domain names prompt file:', err);
    throw err;
  }
}

export async function loadAvailabilityPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/availability_prompt.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading availability prompt file:', err);
    throw err;
  }
}

export async function loadSpokenFamiliarityPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/familiarity_prompt_updated.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading spoken familiarity prompt file:', err);
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

function parseUnityResponse(response: string): ParsedIdiomacityResult[] {
  const lines = response.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedIdiomacityResult[] = [];
  for (const line of lines) {
    const separatorIndex = line.lastIndexOf(' : ');
    if (separatorIndex === -1) {
      continue;
    }

    const parsedForm = line.slice(0, separatorIndex).trim();
    const score = parseInt(line.slice(separatorIndex + 3).trim(), 10);
    if (!parsedForm || Number.isNaN(score)) {
      continue;
    }

    results.push({
      parsedForm,
      category: '',
      score,
    });
  }

  return results;
}

export function parseUnityBucketResponse(response: string): ParsedUnityBucketResult[] {
  const lines = response.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedUnityBucketResult[] = [];
  for (const line of lines) {
    const separatorIndex = line.lastIndexOf(' : ');
    if (separatorIndex === -1) {
      continue;
    }

    const parsedForm = line.slice(0, separatorIndex).trim();
    const bucket = line.slice(separatorIndex + 3).trim();
    if (!parsedForm || !UNITY_BUCKETS.has(bucket)) {
      continue;
    }

    results.push({ parsedForm, bucket });
  }

  return results;
}

export function matchUnityBucketResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedUnityBucketResult[],
): Array<{ phrase: string; parsed: ParsedUnityBucketResult } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ phrase: string; parsed: ParsedUnityBucketResult } | null> = [];

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

export async function scorePhrasesForUnityBucket(
  phrases: string[],
  provider: IAiProvider,
  options: { promptVersion?: 2 | 3 } = {},
): Promise<Map<string, ParsedUnityBucketResult>> {
  const resultsByPhrase = new Map<string, ParsedUnityBucketResult>();
  if (phrases.length === 0) {
    return resultsByPhrase;
  }

  const promptVersion = options.promptVersion ?? 2;
  const promptTemplate =
    promptVersion === 3
      ? await loadUnityBucketPrompt3Async()
      : await loadUnityBucketPromptAsync();
  const promptData = phrases.join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(
    `Sending unity bucket prompt (v${promptVersion}) for ${phrases.length} phrases`,
  );
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received unity bucket response (${aiResponse.length} characters)`);

  const parsedResults = parseUnityBucketResponse(aiResponse);
  const matches = matchUnityBucketResultsToPhrases(phrases, parsedResults);

  for (const match of matches) {
    if (!match) {
      continue;
    }
    resultsByPhrase.set(match.phrase, match.parsed);
  }

  return resultsByPhrase;
}

export async function loadFamiliarityBucketPrompt3Async(): Promise<string> {
  try {
    const promptPath = './src/ai/familiarity_prompt_3.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading familiarity bucket prompt 3 file:', err);
    throw err;
  }
}

export function parseFamiliarityBucketResponse(response: string): ParsedFamiliarityBucketResult[] {
  const lines = response.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedFamiliarityBucketResult[] = [];
  for (const line of lines) {
    const separatorIndex = line.lastIndexOf(' : ');
    if (separatorIndex === -1) {
      continue;
    }

    const parsedForm = line.slice(0, separatorIndex).trim();
    const bucket = line.slice(separatorIndex + 3).trim();
    if (!parsedForm || !FAMILIARITY_BUCKETS.has(bucket)) {
      continue;
    }

    results.push({ parsedForm, bucket });
  }

  return results;
}

function stripTrailingUnityBucketAnnotation(text: string): string {
  return text.replace(/\s*\((Concept|Collocation|Formula|Non-unit|Nonsense)\)\s*$/i, '').trim();
}

export function matchFamiliarityBucketResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedFamiliarityBucketResult[],
): Array<{ phrase: string; parsed: ParsedFamiliarityBucketResult } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ phrase: string; parsed: ParsedFamiliarityBucketResult } | null> = [];

  for (const phrase of phrases) {
    let matchIndex = unmatchedParsed.findIndex(
      (parsed) =>
        normalizeForPhraseMatch(stripTrailingUnityBucketAnnotation(parsed.parsedForm)) ===
        normalizeForPhraseMatch(phrase),
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) =>
          entryToAllCaps(stripTrailingUnityBucketAnnotation(parsed.parsedForm)) ===
          entryToAllCaps(phrase),
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

export async function scorePhrasesForFamiliarityBucket(
  phrases: Array<{ phrase: string; unityBucket: string }>,
  provider: IAiProvider,
): Promise<Map<string, ParsedFamiliarityBucketResult>> {
  const resultsByPhrase = new Map<string, ParsedFamiliarityBucketResult>();
  if (phrases.length === 0) {
    return resultsByPhrase;
  }

  const promptTemplate = await loadFamiliarityBucketPrompt3Async();
  const promptData = phrases
    .map((item) => `${item.phrase} (${item.unityBucket})`)
    .join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending familiarity bucket prompt for ${phrases.length} phrases`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received familiarity bucket response (${aiResponse.length} characters)`);

  const parsedResults = parseFamiliarityBucketResponse(aiResponse);
  const phraseTexts = phrases.map((item) => item.phrase);
  const matches = matchFamiliarityBucketResultsToPhrases(phraseTexts, parsedResults);

  for (const match of matches) {
    if (!match) {
      continue;
    }
    resultsByPhrase.set(match.phrase, match.parsed);
  }

  return resultsByPhrase;
}

export function parseEntryParserResponse(response: string): ParsedEntryParserResult[] {
  const lines = response.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedEntryParserResult[] = [];
  for (const line of lines) {
    const parts = line.split(' : ').map((part) => part.trim());
    if (parts.length < 3) {
      continue;
    }

    const entry = parts[0];
    const entryType = parts[1];
    if (!entry || !ENTRY_PARSER_CATEGORIES.has(entryType)) {
      continue;
    }

    let displayText = parts.slice(2).join(' : ').trim();
    let baseForm: string | undefined;

    const baseMatch = displayText.match(/^(.+?)\s+\((.+)\)$/);
    if (baseMatch) {
      displayText = baseMatch[1].trim();
      baseForm = baseMatch[2].trim();
    }

    if (!displayText) {
      continue;
    }

    results.push({
      entry,
      entryType,
      displayText,
      baseForm,
    });
  }

  return results;
}

export function matchEntryParserResultsToEntries(
  entries: string[],
  parsedResults: ParsedEntryParserResult[],
): Array<{ entry: string; parsed: ParsedEntryParserResult } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ entry: string; parsed: ParsedEntryParserResult } | null> = [];

  for (const entry of entries) {
    let matchIndex = unmatchedParsed.findIndex(
      (parsed) => entryToAllCaps(parsed.entry) === entryToAllCaps(entry),
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => normalizeForPhraseMatch(parsed.entry) === normalizeForPhraseMatch(entry),
      );
    }

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => normalizeForPhraseMatch(parsed.displayText) === normalizeForPhraseMatch(entry),
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
    matches.push({ entry, parsed });
  }

  return matches;
}

export async function parseEntriesWithEntryParser(
  entries: string[],
  provider: GeminiWebAiProvider,
): Promise<Map<string, ParsedEntryParserResult>> {
  const resultsByEntry = new Map<string, ParsedEntryParserResult>();
  if (entries.length === 0) {
    return resultsByEntry;
  }

  const promptTemplate = await loadEntryParserPromptAsync();
  const promptData = entries.join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending entry parser prompt for ${entries.length} entries`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received entry parser response (${aiResponse.length} characters)`);

  const parsedResults = parseEntryParserResponse(aiResponse);
  const matches = matchEntryParserResultsToEntries(entries, parsedResults);

  for (const match of matches) {
    if (!match) {
      continue;
    }
    resultsByEntry.set(match.entry, match.parsed);
  }

  return resultsByEntry;
}

export function parseStrictDomainNamesResponse(response: string): ParsedStrictDomainNamesResult[] {
  const lines = response.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedStrictDomainNamesResult[] = [];
  for (const line of lines) {
    const firstSep = line.indexOf(' : ');
    const lastSep = line.lastIndexOf(' : ');
    if (firstSep === -1 || lastSep === -1 || firstSep === lastSep) {
      continue;
    }

    const entry = line.slice(0, firstSep).trim();
    const step2NaturalForm = line.slice(firstSep + 3, lastSep).trim();
    const displayText = line.slice(lastSep + 3).trim();
    if (!entry || !displayText) {
      continue;
    }

    results.push({
      entry,
      step2NaturalForm,
      displayText,
    });
  }

  return results;
}

export function matchStrictDomainNamesResultsToEntries(
  entries: string[],
  parsedResults: ParsedStrictDomainNamesResult[],
): Array<{ entry: string; parsed: ParsedStrictDomainNamesResult } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ entry: string; parsed: ParsedStrictDomainNamesResult } | null> = [];

  for (const entry of entries) {
    let matchIndex = unmatchedParsed.findIndex(
      (parsed) => entryToAllCaps(parsed.entry) === entryToAllCaps(entry),
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => normalizeForPhraseMatch(parsed.entry) === normalizeForPhraseMatch(entry),
      );
    }

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => normalizeForPhraseMatch(parsed.displayText) === normalizeForPhraseMatch(entry),
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
    matches.push({ entry, parsed });
  }

  return matches;
}

export async function parseEntriesWithStrictDomainNames(
  entries: string[],
  provider: GeminiWebAiProvider,
): Promise<Map<string, ParsedStrictDomainNamesResult>> {
  const resultsByEntry = new Map<string, ParsedStrictDomainNamesResult>();
  if (entries.length === 0) {
    return resultsByEntry;
  }

  const promptTemplate = await loadStrictDomainNamesPromptAsync();
  const promptData = entries.join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending strict domain names prompt for ${entries.length} entries`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received strict domain names response (${aiResponse.length} characters)`);

  const parsedResults = parseStrictDomainNamesResponse(aiResponse);
  const matches = matchStrictDomainNamesResultsToEntries(entries, parsedResults);

  for (const match of matches) {
    if (!match) {
      continue;
    }
    resultsByEntry.set(match.entry, match.parsed);
  }

  return resultsByEntry;
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

  const promptTemplate = await loadUnityPromptAsync();
  const promptData = phrases.join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending unity (idiomacity) prompt for ${phrases.length} phrases`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received unity response (${aiResponse.length} characters)`);

  const parsedResults = parseUnityResponse(aiResponse);
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

export function parseAvailabilityResponse(response: string): ParsedAvailabilityResult[] {
  const lines = response.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedAvailabilityResult[] = [];
  for (const line of lines) {
    const separatorIndex = line.lastIndexOf(' : ');
    if (separatorIndex === -1) {
      continue;
    }

    const phrase = line.slice(0, separatorIndex).trim();
    const tier = line.slice(separatorIndex + 3).trim();
    const familiarityScore = AVAILABILITY_TIER_SCORES[tier];
    if (!phrase || familiarityScore === undefined) {
      continue;
    }

    results.push({ phrase, tier, familiarityScore });
  }

  return results;
}

export function matchAvailabilityResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedAvailabilityResult[],
): Array<{ phrase: string; parsed: ParsedAvailabilityResult } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ phrase: string; parsed: ParsedAvailabilityResult } | null> = [];

  for (const phrase of phrases) {
    let matchIndex = unmatchedParsed.findIndex(
      (parsed) => normalizeForPhraseMatch(parsed.phrase) === normalizeForPhraseMatch(phrase),
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => entryToAllCaps(parsed.phrase) === entryToAllCaps(phrase),
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

export async function scorePhrasesForAvailability(
  phrases: string[],
  provider: GeminiWebAiProvider,
): Promise<Map<string, ParsedAvailabilityResult>> {
  const resultsByPhrase = new Map<string, ParsedAvailabilityResult>();
  if (phrases.length === 0) {
    return resultsByPhrase;
  }

  const promptTemplate = await loadAvailabilityPromptAsync();
  const promptData = phrases.join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending availability prompt for ${phrases.length} phrases`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received availability response (${aiResponse.length} characters)`);

  const parsedResults = parseAvailabilityResponse(aiResponse);
  const matches = matchAvailabilityResultsToPhrases(phrases, parsedResults);

  for (const match of matches) {
    if (!match) {
      continue;
    }
    resultsByPhrase.set(match.phrase, match.parsed);
  }

  return resultsByPhrase;
}

export function parseSpokenFamiliarityResponse(response: string): ParsedSpokenFamiliarityResult[] {
  const lines = response.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedSpokenFamiliarityResult[] = [];
  for (const line of lines) {
    const separatorIndex = line.lastIndexOf(' : ');
    if (separatorIndex === -1) {
      continue;
    }

    const phrase = line.slice(0, separatorIndex).trim();
    const score = parseFloat(line.slice(separatorIndex + 3).trim());
    if (!phrase || Number.isNaN(score)) {
      continue;
    }

    results.push({
      phrase,
      familiarityScore: Math.round(score * 10),
    });
  }

  return results;
}

export function matchSpokenFamiliarityResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedSpokenFamiliarityResult[],
): Array<{ phrase: string; parsed: ParsedSpokenFamiliarityResult } | null> {
  const unmatchedParsed = [...parsedResults];
  const matches: Array<{ phrase: string; parsed: ParsedSpokenFamiliarityResult } | null> = [];

  for (const phrase of phrases) {
    let matchIndex = unmatchedParsed.findIndex(
      (parsed) => normalizeForPhraseMatch(parsed.phrase) === normalizeForPhraseMatch(phrase),
    );

    if (matchIndex === -1) {
      matchIndex = unmatchedParsed.findIndex(
        (parsed) => entryToAllCaps(parsed.phrase) === entryToAllCaps(phrase),
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

export async function scorePhrasesForSpokenFamiliarity(
  phrases: string[],
  lang: string,
  provider: IAiProvider,
): Promise<Map<string, ParsedSpokenFamiliarityResult>> {
  const resultsByPhrase = new Map<string, ParsedSpokenFamiliarityResult>();
  if (phrases.length === 0) {
    return resultsByPhrase;
  }

  const promptTemplate = await loadSpokenFamiliarityPromptAsync();
  const langName = LanguageNames[lang] ?? lang;
  const promptData = phrases.join('\n');
  const prompt = promptTemplate
    .replace(/\[\[LANG\]\]/g, langName)
    .replace('[[DATA]]', promptData);

  console.log(`Sending spoken familiarity prompt for ${phrases.length} ${lang} phrases`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received spoken familiarity response for ${lang} (${aiResponse.length} characters)`);

  const parsedResults = parseSpokenFamiliarityResponse(aiResponse);
  const matches = matchSpokenFamiliarityResultsToPhrases(phrases, parsedResults);

  for (const match of matches) {
    if (!match) {
      continue;
    }
    resultsByPhrase.set(match.phrase, match.parsed);
  }

  return resultsByPhrase;
}

export function computeSpokenFamiliarityScore(
  aiFamiliarityScore: number | null | undefined,
  unityBucket: string | null | undefined,
): number | null {
  if (aiFamiliarityScore == null) {
    return null;
  }

  const isSpokenEligible = unityBucket === 'Concept' || unityBucket === 'Formula';
  if (!isSpokenEligible) {
    return Math.min(aiFamiliarityScore, 35);
  }

  return aiFamiliarityScore;
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
      displayText: familiarity.displayText,
      entryType: familiarity.entryType,
      baseForm: familiarity.baseForm,
      idiomacityScore: idiomacity.score,
      familiarityScore: familiarity.familiarityScore,
    });
  }

  return dedupeScoredPhrasesByEntryKey(qualifying);
}
