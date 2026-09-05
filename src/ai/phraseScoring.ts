import fs from 'fs';
import { LanguageNames } from 'cruzi-models';
import { entryToAllCaps } from '../lib/utils';
import { parseEntryParser3Response } from './entryParserFormat';
import { GeminiWebAiProvider } from './geminiWebProvider';
import { IAiProvider } from './IAiProvider';
import { loadFamiliarityPromptAsync, parseFamiliarityResponse } from './common';
import { matchPhrasesToParsed } from '../lib/resultMatching';

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
  isVulgar?: boolean;
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
  'Partial',
  'Variant',
  'Non-unit',
  'Nonsense',
]);

const FAMILIARITY_BUCKETS = new Set([
  'Easy Collocation',
  'Beginner Core',
  'Ubiquitous',
  'Common Name',
  'Active',
  'Colloquial',
  'General Knowledge',
  'Inferred',
  'Niche',
  'Variant',
  'Partial Phrase',
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

export async function loadEntryParserPrompt3Async(): Promise<string> {
  try {
    const promptPath = './src/ai/entry_parser_prompt_3.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading entry parser prompt 3 file:', err);
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
  return matchPhrasesToParsed(phrases, parsedResults, (parsed) => [parsed.parsedForm]);
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
  const matchedCount = matches.filter((match) => match !== null).length;
  if (parsedResults.length !== phrases.length || matchedCount !== phrases.length) {
    const unmatched = phrases.filter((_, index) => matches[index] === null);
    console.warn(
      `Unity ratings: parsed ${parsedResults.length}, matched ${matchedCount} of ${phrases.length}` +
        (unmatched.length > 0 ? `; unmatched: ${unmatched.slice(0, 8).join(', ')}` : ''),
    );
  }

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

function parseDisplayTextAndBucket(
  line: string,
  resolveBucket: (raw: string) => string | undefined,
): { parsedForm: string; bucket: string } | null {
  const lastColon = line.lastIndexOf(':');
  if (lastColon <= 0) {
    return null;
  }

  const bucket = resolveBucket(line.slice(lastColon + 1).trim());
  if (!bucket) {
    return null;
  }

  const parsedForm = line.slice(0, lastColon).trim();
  if (!parsedForm) {
    return null;
  }

  return { parsedForm, bucket };
}

export function parseFamiliarityBucketResponse(response: string): ParsedFamiliarityBucketResult[] {
  const lines = response.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedFamiliarityBucketResult[] = [];
  for (const line of lines) {
    const parsed = parseDisplayTextAndBucket(line, (raw) =>
      FAMILIARITY_BUCKETS.has(raw) ? raw : undefined,
    );
    if (!parsed) {
      continue;
    }

    results.push(parsed);
  }

  return results;
}

function stripTrailingFamiliarityPromptAnnotations(text: string): string {
  let result = text.trim();
  let previous = '';
  while (result !== previous) {
    previous = result;
    result = result
      .replace(/\s*\((Concept|Collocation|Formula|Partial|Non-unit|Nonsense)\)\s*$/i, '')
      .replace(/\s*\((Word|Phrase|Proper Name|Acronym\/Abbreviation|Prefix\/Suffix)\)\s*$/i, '')
      .trim();
  }
  return result;
}

export function matchFamiliarityBucketResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedFamiliarityBucketResult[],
): Array<{ phrase: string; parsed: ParsedFamiliarityBucketResult } | null> {
  return matchPhrasesToParsed(phrases, parsedResults, (parsed) => [
    stripTrailingFamiliarityPromptAnnotations(parsed.parsedForm),
  ]);
}

const QUALITY_BUCKETS = new Set([
  'Non-unit',
  'Unfamiliar',
  'Uncommon Inflection',
  'Partial',
  'Clunky',
  'Idiomatic',
  'Interesting',
  'Appealing',
  'Emotional',
  'Trendy',
  'Normal',
]);

const QUALITY_BUCKET_ALIASES: Record<string, string> = {
  Fun: 'Trendy',
};

function canonicalQualityBucket(bucket: string): string | undefined {
  if (QUALITY_BUCKETS.has(bucket)) {
    return bucket;
  }
  return QUALITY_BUCKET_ALIASES[bucket];
}

function stripTrailingQualityPromptAnnotations(text: string): string {
  let result = text.trim();
  let previous = '';
  while (result !== previous) {
    previous = result;
    result = result
      .replace(
        /\s*\((Concept|Collocation|Formula|Partial|Non-unit|Nonsense)\)\s*$/i,
        '',
      )
      .replace(
        /\s*\((Easy Collocation|Beginner Core|Ubiquitous|Common Name|Active|Colloquial|General Knowledge|Inferred|Niche|Obscure|Barely Exists|Nonsense)\)\s*$/i,
        '',
      )
      .trim();
  }
  return result;
}

export interface ParsedQualityBucketResult {
  parsedForm: string;
  bucket: string;
}

export async function loadQualityBucketPrompt3Async(): Promise<string> {
  try {
    const promptPath = './src/ai/quality_prompt_3.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading quality bucket prompt 3 file:', err);
    throw err;
  }
}

export function parseQualityBucketResponse(response: string): ParsedQualityBucketResult[] {
  const lines = response.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedQualityBucketResult[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    const parsed = parseDisplayTextAndBucket(cleaned, canonicalQualityBucket);
    if (!parsed) {
      continue;
    }

    const parsedForm = stripTrailingQualityPromptAnnotations(parsed.parsedForm);
    if (!parsedForm) {
      continue;
    }

    results.push({ parsedForm, bucket: parsed.bucket });
  }

  return results;
}

export function matchQualityBucketResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedQualityBucketResult[],
): Array<{ phrase: string; parsed: ParsedQualityBucketResult } | null> {
  return matchPhrasesToParsed(phrases, parsedResults, (parsed) => [
    stripTrailingQualityPromptAnnotations(parsed.parsedForm),
  ]);
}

export async function scorePhrasesForQualityBucket(
  phrases: Array<{ phrase: string; unityBucket: string; familiarityBucket: string }>,
  provider: IAiProvider,
): Promise<Map<string, ParsedQualityBucketResult>> {
  const resultsByPhrase = new Map<string, ParsedQualityBucketResult>();
  if (phrases.length === 0) {
    return resultsByPhrase;
  }

  const promptTemplate = await loadQualityBucketPrompt3Async();
  const promptData = phrases
    .map((item) => `${item.phrase} (${item.unityBucket}) (${item.familiarityBucket})`)
    .join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending quality bucket prompt for ${phrases.length} phrases`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received quality bucket response (${aiResponse.length} characters)`);

  const parsedResults = parseQualityBucketResponse(aiResponse);
  const phraseTexts = phrases.map((item) => item.phrase);
  const matches = matchQualityBucketResultsToPhrases(phraseTexts, parsedResults);
  const matchedCount = matches.filter((match) => match !== null).length;

  if (parsedResults.length !== phrases.length || matchedCount !== phrases.length) {
    console.warn(
      `Quality ratings: parsed ${parsedResults.length}, matched ${matchedCount} of ${phrases.length} phrases`,
    );
  }

  for (const match of matches) {
    if (!match) {
      continue;
    }
    resultsByPhrase.set(match.phrase, match.parsed);
  }

  return resultsByPhrase;
}

export async function scorePhrasesForFamiliarityBucket(
  phrases: Array<{ phrase: string; entryType: string; unityBucket: string }>,
  provider: IAiProvider,
): Promise<Map<string, ParsedFamiliarityBucketResult>> {
  const resultsByPhrase = new Map<string, ParsedFamiliarityBucketResult>();
  if (phrases.length === 0) {
    return resultsByPhrase;
  }

  const promptTemplate = await loadFamiliarityBucketPrompt3Async();
  const promptData = phrases
    .map((item) => `${item.phrase} (${item.entryType}) (${item.unityBucket})`)
    .join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`Sending familiarity bucket prompt for ${phrases.length} phrases`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received familiarity bucket response (${aiResponse.length} characters)`);

  const parsedResults = parseFamiliarityBucketResponse(aiResponse);
  const phraseTexts = phrases.map((item) => item.phrase);
  const matches = matchFamiliarityBucketResultsToPhrases(phraseTexts, parsedResults);
  const matchedCount = matches.filter((match) => match !== null).length;
  if (parsedResults.length !== phrases.length || matchedCount !== phrases.length) {
    const unmatched = phraseTexts.filter((_, index) => matches[index] === null);
    console.warn(
      `Familiarity ratings: parsed ${parsedResults.length}, matched ${matchedCount} of ${phrases.length}` +
        (unmatched.length > 0 ? `; unmatched: ${unmatched.slice(0, 8).join(', ')}` : ''),
    );
  }

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
  return matchPhrasesToParsed(entries, parsedResults, (parsed) => [
    parsed.entry,
    parsed.displayText,
  ]).map((match) => (match ? { entry: match.phrase, parsed: match.parsed } : null));
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

export function parseEntryParser3PrimaryResponse(response: string): ParsedEntryParserResult[] {
  return parseEntryParser3Response(response).map((parsed) => ({
    entry: parsed.entry,
    entryType: parsed.primary.entryType,
    displayText: parsed.primary.displayText,
    baseForm: parsed.primary.baseForm,
    isVulgar: parsed.isVulgar,
  }));
}

export async function parseEntriesWithEntryParser3(
  entries: string[],
  provider: IAiProvider,
): Promise<Map<string, ParsedEntryParserResult>> {
  const resultsByEntry = new Map<string, ParsedEntryParserResult>();
  if (entries.length === 0) {
    return resultsByEntry;
  }

  const promptTemplate = await loadEntryParserPrompt3Async();
  const prompt = promptTemplate.replace('[[DATA]]', entries.join('\n'));

  console.log(`Sending entry parser prompt 3 for ${entries.length} entries`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received entry parser prompt 3 response (${aiResponse.length} characters)`);

  const parsedResults = parseEntryParser3PrimaryResponse(aiResponse);
  const matches = matchEntryParserResultsToEntries(entries, parsedResults);
  const matchedCount = matches.filter((match) => match !== null).length;
  if (parsedResults.length !== entries.length || matchedCount !== entries.length) {
    const unmatched = entries.filter((_, index) => matches[index] === null);
    console.warn(
      `Entry parser 3: parsed ${parsedResults.length}, matched ${matchedCount} of ${entries.length}` +
        (unmatched.length > 0 ? `; unmatched: ${unmatched.slice(0, 8).join(', ')}` : ''),
    );
  }

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
  return matchPhrasesToParsed(entries, parsedResults, (parsed) => [
    parsed.entry,
    parsed.displayText,
    parsed.step2NaturalForm,
  ]).map((match) => (match ? { entry: match.phrase, parsed: match.parsed } : null));
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

export function matchIdiomacityResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedIdiomacityResult[],
): Array<{ phrase: string; parsed: ParsedIdiomacityResult } | null> {
  return matchPhrasesToParsed(phrases, parsedResults, (parsed) => [parsed.parsedForm]);
}

export function matchFamiliarityResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedFamiliarityResult[],
): Array<{ phrase: string; parsed: ParsedFamiliarityResult } | null> {
  return matchPhrasesToParsed(phrases, parsedResults, (parsed) => [
    parsed.entry,
    parsed.displayText,
  ]);
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
  return matchPhrasesToParsed(phrases, parsedResults, (parsed) => [parsed.phrase]);
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
  return matchPhrasesToParsed(phrases, parsedResults, (parsed) => [parsed.phrase]);
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
