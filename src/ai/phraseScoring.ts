import fs from 'fs';
import { LanguageNames } from 'cruzi-models';
import { entryToAllCaps } from '../lib/utils';
import { ParsedEntryParser3Result, parseEntryParser3Response } from './entryParserFormat';
import { GeminiWebAiProvider } from './geminiWebProvider';
import { IAiProvider } from './IAiProvider';
import { loadFamiliarityPromptAsync, parseFamiliarityResponse } from './common';
import { matchPhrasesToParsed } from '../lib/resultMatching';

export interface ParsedUnityBucketResult {
  parsedForm: string;
  bucket: string;
}

export interface ParsedEntryParserResult {
  entry: string;
  classification: string;
  displayText: string;
  baseForm?: string;
  isVulgar?: boolean;
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
  classification: string;
  baseForm?: string;
  familiarityScore: number;
}

export interface ParsedAvailabilityResult {
  phrase: string;
  tier: string;
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
  'Formulaic',
  'Non-unit',
  'Nonsense',
]);

const FAMILIARITY_BUCKETS = new Set([
  'Literal',
  'Ubiquitous',
  'Common Name',
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
  domain?: string;
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

export async function loadAvailabilityPromptAsync(): Promise<string> {
  try {
    const promptPath = './src/ai/availability_prompt.txt';
    return await fs.promises.readFile(promptPath, 'utf-8');
  } catch (err) {
    console.error('Error reading availability prompt file:', err);
    throw err;
  }
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
  resolveBucket: (raw: string) => { bucket: string; domain?: string } | undefined,
): { parsedForm: string; bucket: string; domain?: string } | null {
  const lastColon = line.lastIndexOf(':');
  if (lastColon <= 0) {
    return null;
  }

  const resolved = resolveBucket(line.slice(lastColon + 1).trim());
  if (!resolved) {
    return null;
  }

  const parsedForm = line.slice(0, lastColon).trim();
  if (!parsedForm) {
    return null;
  }

  return { parsedForm, bucket: resolved.bucket, ...(resolved.domain ? { domain: resolved.domain } : {}) };
}

export function parseFamiliarityBucketResponse(response: string): ParsedFamiliarityBucketResult[] {
  const lines = response.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  const results: ParsedFamiliarityBucketResult[] = [];
  for (const line of lines) {
    const parsed = parseDisplayTextAndBucket(line, (raw) => {
      const domainMatch = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
      const bucket = (domainMatch ? domainMatch[1] : raw).trim();
      const domain = domainMatch?.[2]?.trim();
      if (!FAMILIARITY_BUCKETS.has(bucket)) {
        return undefined;
      }
      return { bucket, ...(domain ? { domain } : {}) };
    });
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
      .replace(/\s*\((Concept|Collocation|Formula|Partial|Variant|Formulaic|Non-unit|Nonsense)\)\s*$/i, '')
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
  'Uncommon Inflection',
  'Clunky',
  'Idiomatic',
  'Interesting',
  'Appealing',
  'Positive',
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
        /\s*\((Concept|Collocation|Formula|Partial|Variant|Formulaic|Non-unit|Nonsense)\)\s*$/i,
        '',
      )
      .replace(
        /\s*\((Literal|Easy Collocation|Beginner Core|Ubiquitous|Common Name|Active|Colloquial|General Knowledge|Inferred|Niche|Obscure|Barely Exists|Nonsense)\)\s*$/i,
        '',
      )
      .replace(/\s*\((?:vulgar|sensitive)(?:\s*,\s*(?:vulgar|sensitive))?\)\s*$/i, '')
      .trim();
  }
  return result;
}

const QUALITY_FLAG_SUFFIX =
  /\s*\(((?:vulgar|sensitive)(?:\s*,\s*(?:vulgar|sensitive))?)\)\s*$/i;

function splitQualityBucketAndFlags(raw: string): { bucket: string; flags: string[] } {
  const match = raw.match(QUALITY_FLAG_SUFFIX);
  if (!match || match.index == null) {
    return { bucket: raw.trim(), flags: [] };
  }

  const flags = [...new Set(
    match[1]
      .split(',')
      .map((flag) => flag.trim().toLowerCase())
      .filter((flag) => flag === 'vulgar' || flag === 'sensitive'),
  )];
  return { bucket: raw.slice(0, match.index).trim(), flags };
}

export interface ParsedQualityBucketResult {
  parsedForm: string;
  bucket: string;
  flags: string[];
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
    const lastColon = cleaned.lastIndexOf(':');
    if (lastColon <= 0) {
      continue;
    }

    const { bucket: bucketText, flags } = splitQualityBucketAndFlags(cleaned.slice(lastColon + 1));
    const bucket = canonicalQualityBucket(bucketText);
    const parsedForm = stripTrailingQualityPromptAnnotations(cleaned.slice(0, lastColon).trim());
    if (!bucket || !parsedForm) {
      continue;
    }

    results.push({ parsedForm, bucket, flags });
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
  phrases: Array<{ phrase: string; classification: string; unityBucket: string }>,
  provider: IAiProvider,
): Promise<Map<string, ParsedFamiliarityBucketResult>> {
  const resultsByPhrase = new Map<string, ParsedFamiliarityBucketResult>();
  if (phrases.length === 0) {
    return resultsByPhrase;
  }

  const promptTemplate = await loadFamiliarityBucketPrompt3Async();
  const promptData = phrases
    .map((item) => `${item.phrase} (${item.classification}) (${item.unityBucket})`)
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
    const classification = parts[1];
    if (!entry || !ENTRY_PARSER_CATEGORIES.has(classification)) {
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
      classification,
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
    classification: parsed.primary.classification,
    displayText: parsed.primary.displayText,
    baseForm: parsed.primary.baseForm,
  }));
}

export async function parseEntriesWithEntryParser3Full(
  entries: string[],
  provider: IAiProvider,
): Promise<ParsedEntryParser3Result[]> {
  if (entries.length === 0) {
    return [];
  }

  const promptTemplate = await loadEntryParserPrompt3Async();
  const prompt = promptTemplate.replace('[[DATA]]', entries.join('\n'));

  console.log(`Sending entry parser prompt 3 for ${entries.length} entries`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`Received entry parser prompt 3 response (${aiResponse.length} characters)`);

  const parsedResults = parseEntryParser3Response(aiResponse);
  console.log(`Parsed ${parsedResults.length} entry parser 3 results (including secondaries)`);
  return parsedResults;
}

export async function parseEntriesWithEntryParser3(
  entries: string[],
  provider: IAiProvider,
): Promise<Map<string, ParsedEntryParserResult>> {
  const resultsByEntry = new Map<string, ParsedEntryParserResult>();
  if (entries.length === 0) {
    return resultsByEntry;
  }

  const parsedFull = await parseEntriesWithEntryParser3Full(entries, provider);
  const parsedResults = parsedFull.map((parsed) => ({
    entry: parsed.entry,
    classification: parsed.primary.classification,
    displayText: parsed.primary.displayText,
    baseForm: parsed.primary.baseForm,
  }));
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

export function matchFamiliarityResultsToPhrases(
  phrases: string[],
  parsedResults: ParsedFamiliarityResult[],
): Array<{ phrase: string; parsed: ParsedFamiliarityResult } | null> {
  return matchPhrasesToParsed(phrases, parsedResults, (parsed) => [
    parsed.entry,
    parsed.displayText,
  ]);
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
