/*
This is a multistep process.
Only one puzzle_id should be processed at a time, but the clues can be processed in parallel.
All items in a given step should be completed before moving on to the next step.
Parallel processing should be handled as familiarGenerator.ts does.

STEP 1 (Inflections):
- Read a puzzle_id from crossword_processing_queue. Delete that queue row only when the puzzle has finished processing.
- Query the entry table for all entries in the puzzle whose loading_status does not start with "I".
- Check each entry to see if it has reviewed_status starting with "1". If not, run them through the entryParser process to
    generate display_text, classification, and potentially entry_secondary_class records.
  - The parser considers phrasal verb parsings (CRAWLIN -> "crawl in", not "crawlin'").
- Send an AI query using inflections_prompt.txt (AI provider passed in as a parameter). 20 entries per query.
  - Also check entry_secondary_class for alternate display_texts. If multiple display_texts exist for an entry,
    send them to inflections_prompt.txt as separate line items.
- Before sending the AI query, delete all existing inflected_entry rows for each of those entries (as base_entry).
- If the AI query returns results for an item:
  - For any returned inflected forms and/or base forms that don't already exist in the entry table, create them using the
    display text returned by the prompt. Insert an entry_tags row with tag 'inflection_generator' for
    each newly created inflected-form or base-form entry.
  - Create new rows in inflected_entry according to the AI results. If base_form(s) were returned, create the appropriate rows
      but no need to populate the inflected_type field.
  - Existing senses of the item are kept, even if a base form for the item was returned.
- Set loading_status on all entries sent to AI to "I".
- For clues whose entries did not initially have loading_status starting with "I", set match_attempted to false.

STEP 2 (Clue Matching, first pass):
- Fetch all the clues and entries for the given puzzle_id whose match_attempted is false. Include all existing senses for
    the entries, from both the entry itself and from every base form if any exist.
  - Base forms are inflected_entry rows where the puzzle entry is the inflected_form.
  - An entry can have multiple base forms (e.g. DOES -> DOE and DO).
- Generate an AI prompt using crossword_matching_prompt.txt and fetch the results 
    (use the AIProvider passed in as a parameter). Send 10 entries per prompt.
  - A clue's sense_id can point to a sense of a base form entry or the entry itself. The prompt results will
      indicate the entry whose sense was matched.
  - Base form senses are preferred, even when the clue itself is inflected (e.g. a past-tense or comparative clue).
      Only match a sense of the inflected entry itself when that sense doesn't make sense for the base form.
- Update the matched clue records with the matched sense ids and set match_attempted to true.
- Clues that could not be matched (no senses, Unclear, no existing sense, or missing from the AI response) keep
    match_attempted false; that is how they are tracked into steps 3 and 4.
- Personal names: when the entry is a single given name or surname, a clue referring to a person with that name matches
    the general "Personal Name" sense. Only when the name alone is very strongly affiliated with one specific person
    (e.g. Tiger -> Tiger Woods, Adele -> Adele Adkins, but not Michael) can the clue match a sense for that person.

STEP 3 (Sense Generation):
- Fetch the puzzle entries that have clues with match_attempted false (this includes entries that have no senses).
- Send each entry to senses_prompt.txt. (One item per prompt.)
  - As the hint in the prompt, send the clue(s) that couldn't be matched, so the clue can factor into discovering senses.
  - Send every different display_text of the entry to the prompt. This includes the entry's display_text and the display_text 
     of all entry_secondary_class records (deduplicate).
  - As existing senses, send the senses of the entry itself and of every base form.
  - Send the display_text of every base form from inflected_entry (generated in step 1), so the prompt doesn't have to
     guess the base form. Base forms include those of plurals, verb conjugations, comparatives, and superlatives.
  - Senses are generated for every part of speech the item (or its base form) is actually used as.
  - When the prompt can't make sense of a clue in relation to the answer, it may web search for similar clue/answer pairs.
     Clues that can never map to a sense (e.g. "See 55-Down") are fine to leave unmatched.
- The prompt returns a list of changes to apply to the existing senses (not a replacement list):
  - ADD: insert a new sense. The prompt may return senses for the base form of the item as well as for the item itself.
    The natural form of each sense indicates which form the sense is for. Insert the sense on the entry matching that
    display text (the item itself or one of its base forms).
    - The display text must match the item (or the base form it belongs to) letter for letter in its alphanumeric
      characters; it may differ only in spacing, capitalization, and punctuation. Skip ADDs that don't.
    - If a sense comes back with summary of "Literal", insert "Literal" into the summary field and leave the definition field blank.
    - When the entry is a single given name or surname, there should be a general "Personal Name" sense (summary and
      definition both "Personal Name"). Senses for a specific person with that name are only generated when the name alone
      is very strongly affiliated with that person (e.g. Tiger -> Tiger Woods, Adele -> Adele Adkins, but not Michael).
    - If Regionality is anything other than Widespread, insert a sense_tags row with tag "regionality" and value the region from the prompt.
    - Skip an ADD that duplicates the summary of an existing sense on the same entry.
  - COMBINE: merge the two existing senses into one. Keep the sense that is further along in reviewed_status (tiebreak: the
    base form's sense, then the first one listed). Repoint clues from the removed sense to the kept one, then delete the removed sense.
  - IMPROVE: update the summary of the existing sense.
  - Existing senses may belong to base forms, so changes can apply to the base form entries.

STEP 4 (Clue Matching, second pass):
- Repeat step 2 for the clues that still have match_attempted false (including the personal name rules).
- If still no match can be made (no senses, Unclear, or no existing sense), give up: leave sense_id null and set
    match_attempted to true. Clues missing from the AI response are left for retry.
- At the end of the step, all clues from the puzzle should have match_attempted set to true.

STEP 5 (Sense Scoring):
Loop through the steps until all eligible senses have been scored.
- Fetch a number of senses that were matched with clues for the puzzle_id and have reviewed_status not "234"
   (number to select at a time is based on the parallel processing parameters).
- Run the items through a pipeline of sense_unity_prompt.txt, sense_familiarity_prompt.txt, and sense_quality_prompt.txt. 
   Take inspiration from unityGenerator.ts, familiarityGenerator.ts, and qualityGenerator.ts to implement the pipeline,
   refactoring out common code where possible to avoid code duplication. Batches of 50 per prompt.
- After the unity prompt, update the unity_bucket and set the reviewed_status of the sense to "2".
  - Senses that score Non-unit or Nonsense are kept (not deleted) and continue through the pipeline.
- After the familiarity prompt, update the reviewed_status to "23" and set sense.domain from the parenthetical domain/area when the prompt returns one.
  - Common Name is only for names shared by a wide variety of people; uncommon names get a different bucket.
  - Foreign words in actual use in US English-speaking culture (siesta, quid pro quo) are not Obscure.
- Personal Name senses (given names, surnames) are never rated Clunky for quality.
- After the quality prompt, update the reviewed_status to "234".
   - Vulgar and Sensitive are parenthetical flags, not buckets. Replace the sense's sense_tags rows for
     'vulgar' and 'sensitive' with the flags on this result.
- When a sense has been scored successfully for unity, familiarity, and quality, count how many senses for that entry have been scored. 
  If 2 or more senses are scored, or if the scored sense is the only sense (scored or not) that exists for the entry, update the entry 
  record to match the selected scored sense. 
  Fields to update: display_text, classification (from sense.classification), unity_bucket, familiarity_bucket, quality_bucket, domain. 
  Also set the corresponding scores from UNITY_SCORES / FAMILIARITY_SCORES / QUALITY_SCORES.
  Replace the entry's entry_tags rows for 'vulgar' and 'sensitive' so they match that sense's sense_tags.
  The sense to use to update the entry is selected as follows:
  1. Highest unity_bucket: Concept > Collocation > Formula > Formulaic > Variant > Partial > Non-unit > Nonsense.
  2. Tiebreaker: highest familiarity_bucket: Ubiquitous > Active > Literal > Common Name >
     General Knowledge > Inferred > Niche > Obscure > Barely Exists > Nonsense.
  3. Tiebreaker: highest quality_bucket: Idiomatic > Interesting > Feel-Good >
     Trendy > Normal > Uncommon Derivation > Clunky > Non-unit.
  4. Tiebreaker: pick one at random.

STEP 6 (Sense References):
- Fetch a number of senses that were matched with clues for the puzzle_id and have their references_attempted field set to false.
  (number to select at a time is based on the parallel processing parameters).
- Before generating references, delete any existing sense_reference rows for the senses being processed.
- Generate an AI request to sense_reference_prompt.txt with the senses. Send 10 senses per prompt.
  - Send the display text of the sense to the prompt.
- Update the sense_reference table with the new references.
- Set the references_attempted field to true for the senses that were processed.

STEP 7 (Sense Lore):
- Fetch a number of senses that were matched with clues for the puzzle_id and have their lore_attempted field set to false.
  (number to select at a time is based on the parallel processing parameters).
- Before generating lore, delete any existing sense_lore rows for the senses being processed.
- Generate an AI request to sense_lore_prompt.txt with the senses. Send 10 senses per prompt.
  - Send the display text of the sense to the prompt.
- Insert the lore text into the sense_lore table.
- Set the lore_attempted field to true for the senses that were processed.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  applyInflectionGeneratorResults,
  ClueSenseMatchUpdate,
  deferCrosswordProcessingPuzzle,
  deleteCrosswordProcessingPuzzle,
  deleteInflectedEntriesForBaseEntries,
  deleteSenseLore,
  deleteSenseReferences,
  fillEntryFieldsFromScoredSenses,
  GeneratedSenseInsert,
  getMatchedSensesForScoring,
  getMatchedSensesWithoutLore,
  getMatchedSensesWithoutReferences,
  getPuzzleCluesForProcessing,
  getPuzzleEntriesForInflections,
  getPuzzleEntriesForSenseGeneration,
  InflectionGeneratorForm,
  InflectionGeneratorResult,
  insertGeneratedSenses,
  insertSenseLore,
  insertSenseReferences,
  markSensesLoreAttempted,
  markSensesReferencesAttempted,
  mergeSenses,
  pullCrosswordProcessingPuzzle,
  PuzzleClueForProcessing,
  PuzzleEntryForInflections,
  PuzzleEntryForSenseGeneration,
  PuzzleSenseForProcessing,
  PuzzleSenseLoreItem,
  PuzzleSenseReferenceItem,
  PuzzleSenseScoringItem,
  resetPuzzleClueMatchAttemptedForEntries,
  SenseGenerationExistingSense,
  SenseMerge,
  SenseSummaryUpdate,
  updateClueSenseMatches,
  updateSenseScoringResults,
  updateSenseSummaries,
} from 'cruzi-db';
import { LanguageNames } from 'cruzi-models';
import { readPromptFile } from './ai/common';
import { CursorAiProvider } from './ai/cursor';
import { IAiProvider } from './ai/IAiProvider';
import { parseProvidedEntries } from './entryParser';
import { parseRegionalityValue } from './sensesGenerator';
import { matchParsedResultsByIdentity } from './lib/resultMatching';
import { batchArray, displayTextToEntry, entryToAllCaps, generateId, isGeminiTimeoutError } from './lib/utils';

const CLUES_PER_MATCH_PROMPT = 10;
const ENTRIES_PER_INFLECTION_PROMPT = 20;
const REFERENCES_PER_PROMPT = 10;
const LORE_PER_PROMPT = 10;
const SCORING_BATCH_SIZE = 50;
const DEFAULT_PARALLEL_REQUESTS = 1;

const PERSONAL_NAME_SUMMARY = 'Personal Name';

const INFLECTION_TAGS = new Set(['PL', '3P', 'PT', 'PP', 'GR', 'CP', 'SP']);

const SENSE_UNITY_BUCKETS = new Set([
  'Concept',
  'Collocation',
  'Formula',
  'Partial',
  'Variant',
  'Formulaic',
  'Non-unit',
  'Nonsense',
]);

const SENSE_FAMILIARITY_BUCKETS = new Set([
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

const SENSE_QUALITY_BUCKETS = new Set([
  'Non-unit',
  'Uncommon Derivation',
  'Clunky',
  'Idiomatic',
  'Interesting',
  'Feel-Good',
  'Trendy',
  'Normal',
]);

const QUALITY_FLAG_SUFFIX =
  /\s*\(((?:vulgar|sensitive)(?:\s*,\s*(?:vulgar|sensitive))?)\)\s*$/i;

const REFERENCE_TYPES = new Map<string, string>([
  ['literature', 'Literature'],
  ['quote', 'Quote'],
  ['movies/tv', 'Movies/TV'],
  ['music', 'Music'],
]);

const cursorProvider = new CursorAiProvider();

type ParsedClueMatch =
  | { kind: 'unclear' }
  | {
      kind: 'sense';
      summary: string;
      naturalForm: string;
      classification: string;
      partOfSpeech: string;
    };

type BucketRating = { parsedForm: string; bucket: string; flags: string[]; domain?: string };

type ParsedSenseReference = {
  item: string;
  summary: string;
  references: Array<{
    type: string;
    source: string | null;
    url: string | null;
    text: string;
  }>;
};

type ParsedSenseLore = {
  item: string;
  summary: string;
  loreText: string;
};

type ParsedInflectedForm = {
  partOfSpeech: string;
  tag: string;
  displayText: string;
};

export type ParsedInflectionBlock = {
  item: string;
  baseForms: string[];
  forms: ParsedInflectedForm[];
};

export type ParsedSenseAdd = {
  partOfSpeech: string;
  classification: string;
  displayText: string;
  summary: string;
  definition: string;
  regionality?: string;
  naturalTranslations: string[];
  colloquialTranslations: string[];
  alternatives: string[];
};

export type ParsedSenseChanges = {
  adds: ParsedSenseAdd[];
  combines: Array<{ first: string; second: string }>;
  improves: Array<{ oldSummary: string; newSummary: string }>;
};

type MatchOutcome =
  | { kind: 'unparsed'; clue: PuzzleClueForProcessing }
  | { kind: 'unclear'; clue: PuzzleClueForProcessing }
  | { kind: 'unmatched'; clue: PuzzleClueForProcessing; summary: string }
  | { kind: 'matched'; clue: PuzzleClueForProcessing; sense: PuzzleSenseForProcessing };

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function cluePromptText(customClue: string | null | undefined): string {
  return (customClue ?? '').replace(/\s+/g, ' ').trim();
}

function fillPrompt(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.split(key).join(value);
  }
  return result;
}

async function readPrompt(relativePath: string): Promise<string> {
  return readPromptFile(relativePath);
}

function removeParenthesizedComments(text: string): string {
  return text.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

export function entryDisplayTexts(item: {
  entry: string;
  displayText: string | null;
  secondaryDisplays: string[];
}): string[] {
  const texts = uniqueInOrder(
    [item.displayText?.trim() ?? '', ...item.secondaryDisplays.map((text) => text.trim())].filter(Boolean),
  );
  return texts.length > 0 ? texts : [item.entry];
}

function parseInflectionTaggedForms(parts: string[]): ParsedInflectedForm[] {
  const partOfSpeech = parts[0];
  const forms: ParsedInflectedForm[] = [];
  for (const part of parts.slice(1)) {
    const separatorIndex = part.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const tag = part.slice(0, separatorIndex).trim().toUpperCase();
    const displayText = part.slice(separatorIndex + 1).trim();
    if (!INFLECTION_TAGS.has(tag) || !displayText) {
      continue;
    }
    forms.push({ partOfSpeech, tag, displayText });
  }
  return forms;
}

export function parseInflectionsResponse(
  response: string,
  items: string[],
): Map<string, ParsedInflectionBlock> {
  const lines = response
    .replace(/```(?:\w+)?/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const knownItems = new Set(items);
  const blocks = new Map<string, ParsedInflectionBlock>();
  let current: ParsedInflectionBlock | null = null;

  for (const line of lines) {
    if (knownItems.has(line)) {
      current = blocks.get(line) ?? { item: line, baseForms: [], forms: [] };
      blocks.set(line, current);
      continue;
    }

    if (current == null) {
      continue;
    }

    const parts = line.split('|').map((part) => part.trim()).filter((part) => part !== '');
    if (parts.length < 2) {
      continue;
    }
    if (parts[0].toLowerCase() === 'base form') {
      current.baseForms.push(...parts.slice(1));
      continue;
    }
    current.forms.push(...parseInflectionTaggedForms(parts));
  }

  return blocks;
}

function mergeInflectionForms(forms: ParsedInflectedForm[]): InflectionGeneratorForm[] {
  const merged = new Map<string, InflectionGeneratorForm>();
  for (const form of forms) {
    const key = displayTextToEntry(form.displayText);
    if (!key) {
      continue;
    }
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { displayText: form.displayText, inflectedType: form.tag });
      continue;
    }
    const tags = new Set(
      existing.inflectedType.split(',').map((tag) => tag.trim()).filter(Boolean),
    );
    tags.add(form.tag);
    existing.inflectedType = [...tags].sort().join(',');
  }
  return [...merged.values()];
}

async function processInflectionBatch(
  entries: PuzzleEntryForInflections[],
  provider: IAiProvider,
  promptTemplate: string,
  requestLabel: string,
): Promise<boolean> {
  if (entries.length === 0) {
    return true;
  }
  const promptItems = entries.map((entry) => ({
    entry,
    displayTexts: entryDisplayTexts(entry),
  }));
  const lineItems = promptItems.flatMap((item) => item.displayTexts);
  const prompt = fillPrompt(promptTemplate, {
    '[[DATA]]': lineItems.join('\n'),
  });
  await deleteInflectedEntriesForBaseEntries(entries.map((entry) => ({ entry: entry.entry, lang: entry.lang })));
  console.log(`${requestLabel}: deleted existing inflected_entry rows for ${entries.length} base entries`);
  console.log(
    `${requestLabel}: sending inflections prompt for ${entries.length} entries (${lineItems.length} line items)`,
  );

  const response = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: received response (${response.length} characters)`);
  const parsed = parseInflectionsResponse(response, lineItems);
  console.log(`${requestLabel}: parsed ${parsed.size} of ${lineItems.length} line items`);
  if (parsed.size === 0) {
    console.warn(`${requestLabel}: nothing parseable in response; leaving entries for retry`);
    return false;
  }

  const results: InflectionGeneratorResult[] = promptItems.map((item) => {
    const blocks = item.displayTexts
      .map((displayText) => parsed.get(displayText))
      .filter((block): block is ParsedInflectionBlock => block != null);
    const inflections = mergeInflectionForms(blocks.flatMap((block) => block.forms));
    const baseForms = uniqueInOrder(blocks.flatMap((block) => block.baseForms))
      .filter((baseForm) => displayTextToEntry(baseForm) !== item.entry.entry);

    if (blocks.length === 0) {
      console.log(`${requestLabel}: ${item.entry.entry} -> no results`);
    } else if (inflections.length === 0 && baseForms.length === 0) {
      console.log(`${requestLabel}: ${item.entry.entry} -> (None)`);
    } else {
      console.log(
        `${requestLabel}: ${item.entry.entry} -> ${inflections.length} inflected forms` +
          `${baseForms.length > 0 ? `, base forms ${baseForms.join(', ')}` : ''}`,
      );
    }

    return {
      entry: item.entry.entry,
      lang: item.entry.lang,
      hasResults: blocks.length > 0,
      inflections,
      baseForms,
    };
  });

  await applyInflectionGeneratorResults(results);
  return true;
}

function sensesForMatchingPrompt(clue: PuzzleClueForProcessing): PuzzleSenseForProcessing[] {
  return [...clue.senses].sort((a, b) => {
    const aOwn = a.entry === clue.entry ? 1 : 0;
    const bOwn = b.entry === clue.entry ? 1 : 0;
    if (aOwn !== bOwn) {
      return aOwn - bOwn;
    }
    return a.entry.localeCompare(b.entry) || a.summary.localeCompare(b.summary) || a.id.localeCompare(b.id);
  });
}

function buildClueGroup(clue: PuzzleClueForProcessing): string {
  const lines = [`${cluePromptText(clue.customClue)} : ${clue.entry}`];
  for (const sense of sensesForMatchingPrompt(clue)) {
    if (!sense.summary.trim()) {
      continue;
    }
    const naturalForm = sense.displayText.trim() || sense.entry;
    const classification = sense.classification.trim() || 'Word';
    const partOfSpeech = sense.partOfSpeech.trim() || 'noun';
    lines.push(`${sense.summary.trim()} : ${naturalForm} : ${classification} : ${partOfSpeech}`);
  }
  return lines.join('\n');
}

export function parseCrosswordMatchingResponse(
  response: string,
  clues: Array<{ clueId: string; customClue: string | null; entry: string }>,
): Map<string, ParsedClueMatch> {
  const lines = response
    .replace(/```(?:\w+)?/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const remaining = [...clues];
  const matches = new Map<string, ParsedClueMatch>();

  for (const line of lines) {
    const matchIndex = remaining.findIndex((clue) =>
      line.startsWith(`${cluePromptText(clue.customClue)} : ${clue.entry}`),
    );
    if (matchIndex === -1) {
      continue;
    }

    const clue = remaining.splice(matchIndex, 1)[0];
    const prefix = `${cluePromptText(clue.customClue)} : ${clue.entry}`;
    const rest = line.slice(prefix.length).replace(/^\s*:\s*/, '').trim();
    const fields = rest.split(' : ').map((field) => field.trim()).filter((field) => field !== '');
    if (fields.length === 0 || fields[0].toLowerCase() === 'unclear') {
      matches.set(clue.clueId, { kind: 'unclear' });
      continue;
    }

    matches.set(clue.clueId, {
      kind: 'sense',
      summary: fields[0],
      naturalForm: fields[1] ?? '',
      classification: fields[2] ?? '',
      partOfSpeech: fields.slice(3).join(' : '),
    });
  }

  return matches;
}

function senseMatchesNaturalForm(
  sense: PuzzleSenseForProcessing,
  naturalForm: string,
  clueEntry: string,
): boolean {
  const natural = naturalForm.trim();
  if (!natural) {
    return false;
  }
  if (sense.displayText.trim().toLowerCase() === natural.toLowerCase()) {
    return true;
  }
  const naturalKey = entryToAllCaps(natural);
  if (!naturalKey) {
    return false;
  }
  return sense.entry === naturalKey || (sense.entry === clueEntry && entryToAllCaps(sense.displayText) === naturalKey);
}

export function matchSenseFromPromptResult(
  senses: PuzzleSenseForProcessing[],
  summary: string,
  naturalForm: string,
  clueEntry: string,
): PuzzleSenseForProcessing | null {
  const trimmed = summary.trim();
  if (!trimmed) {
    return null;
  }

  let candidates = senses.filter((sense) => sense.summary.trim() === trimmed);
  if (candidates.length === 0) {
    const lower = trimmed.toLowerCase();
    candidates = senses.filter((sense) => sense.summary.trim().toLowerCase() === lower);
  }
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const byForm = candidates.filter((sense) => senseMatchesNaturalForm(sense, naturalForm, clueEntry));
  const pool = byForm.length > 0 ? byForm : candidates;
  return pool.find((sense) => sense.entry !== clueEntry)
    ?? pool.find((sense) => sense.entry === clueEntry)
    ?? pool[0];
}

export function parseSenseBucketResponse(response: string, allowed: Set<string>): BucketRating[] {
  const lines = response
    .replace(/```(?:\w+)?/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const results: BucketRating[] = [];

  for (const line of lines) {
    const cleaned = line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    const separatorIndex = cleaned.lastIndexOf(' : ');
    if (separatorIndex === -1) {
      continue;
    }
    const parsedForm = cleaned.slice(0, separatorIndex).trim();
    const { bucket, flags, domain } = splitBucketFlagsAndDomain(cleaned.slice(separatorIndex + 3));
    if (!parsedForm || !allowed.has(bucket)) {
      continue;
    }
    results.push({ parsedForm, bucket, flags, ...(domain ? { domain } : {}) });
  }

  return results;
}

function splitBucketAndFlags(raw: string): { bucket: string; flags: string[] } {
  const match = raw.trim().match(QUALITY_FLAG_SUFFIX);
  if (!match || match.index == null) {
    return { bucket: raw.trim(), flags: [] };
  }

  const flags = [...new Set(
    match[1]
      .split(',')
      .map((flag) => flag.trim().toLowerCase())
      .filter((flag) => flag === 'vulgar' || flag === 'sensitive'),
  )];
  return { bucket: raw.trim().slice(0, match.index).trim(), flags };
}

function splitBucketFlagsAndDomain(raw: string): { bucket: string; flags: string[]; domain?: string } {
  const { bucket: withDomain, flags } = splitBucketAndFlags(raw);
  const domainMatch = withDomain.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!domainMatch) {
    return { bucket: withDomain, flags };
  }

  const bucket = domainMatch[1].trim();
  const domain = domainMatch[2].trim();
  if (!bucket) {
    return { bucket: withDomain, flags };
  }
  return { bucket, flags, ...(domain ? { domain } : {}) };
}

function cleanReferenceField(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed || trimmed.toLowerCase() === '(none)') {
    return null;
  }
  return trimmed;
}

export function parseSenseReferenceResponse(response: string): ParsedSenseReference[] {
  const lines = response
    .replace(/```(?:\w+)?/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const blocks: ParsedSenseReference[] = [];
  let current: ParsedSenseReference | null = null;

  for (const line of lines) {
    const categoryMatch = line.match(/^(Literature|Quote|Movies\/TV|Music|\(None\))\s*:/i);
    if (categoryMatch) {
      if (!current) {
        continue;
      }
      const type = REFERENCE_TYPES.get(categoryMatch[1].toLowerCase());
      if (!type) {
        continue;
      }
      const parts = line.split(' : ').map((part) => part.trim());
      const text = cleanReferenceField(parts.slice(3).join(' : '));
      if (!text) {
        continue;
      }
      current.references.push({
        type,
        source: cleanReferenceField(parts[1]),
        url: cleanReferenceField(parts[2]),
        text,
      });
      continue;
    }

    const parts = line.split(' : ').map((part) => part.trim()).filter((part) => part !== '');
    if (parts.length < 2) {
      continue;
    }
    current = {
      item: parts[0],
      summary: parts.slice(1).join(' : '),
      references: [],
    };
    blocks.push(current);
  }

  return blocks;
}

function normalizeHeaderLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function parseSenseLoreResponse(response: string, expectedHeaders: string[] = []): ParsedSenseLore[] {
  const lines = response
    .replace(/```(?:\w+)?/g, '')
    .split('\n')
    .map((line) => line.trim());
  const knownHeaders = new Set(expectedHeaders.map(normalizeHeaderLine));
  const blocks: ParsedSenseLore[] = [];
  const loreLines: string[] = [];
  let current: ParsedSenseLore | null = null;
  let field: 'lore' | null = null;
  let previousBlank = true;

  const finishBlock = () => {
    if (current) {
      current.loreText = loreLines.join('\n').trim();
    }
    loreLines.length = 0;
  };

  for (const line of lines) {
    if (line === '') {
      if (field === 'lore') {
        loreLines.push('');
      }
      previousBlank = true;
      continue;
    }

    const loreMatch = line.match(/^Lore(?:\s+Text)?:\s*(.*)$/i);
    const isKeywordLine = Boolean(loreMatch);
    const isHeader = !isKeywordLine
      && line.includes(' : ')
      && (current == null
        || knownHeaders.has(normalizeHeaderLine(line))
        || (field !== 'lore' && previousBlank));
    previousBlank = false;

    if (isHeader) {
      finishBlock();
      const separatorIndex = line.indexOf(' : ');
      current = {
        item: line.slice(0, separatorIndex).trim(),
        summary: line.slice(separatorIndex + 3).trim(),
        loreText: '',
      };
      blocks.push(current);
      field = null;
      continue;
    }

    if (!current) {
      continue;
    }

    if (loreMatch) {
      field = 'lore';
      if (loreMatch[1].trim()) {
        loreLines.push(loreMatch[1].trim());
      }
    } else if (field === 'lore') {
      loreLines.push(line);
    }
  }
  finishBlock();

  return blocks;
}

async function runWaves<T>(
  items: T[],
  concurrency: number,
  label: string,
  worker: (item: T, requestLabel: string) => Promise<boolean>,
): Promise<boolean> {
  const width = Math.max(1, concurrency);
  let ok = true;

  for (let offset = 0; offset < items.length; offset += width) {
    const wave = items.slice(offset, offset + width);
    console.log(`${label}: ${wave.length} parallel requests (${offset}/${items.length} started)`);
    await Promise.all(
      wave.map(async (item, index) => {
        const requestLabel = `${label} ${offset + index + 1}/${items.length}`;
        try {
          const succeeded = await worker(item, requestLabel);
          if (!succeeded) {
            ok = false;
          }
        } catch (error) {
          if (isGeminiTimeoutError(error)) {
            ok = false;
            console.warn(`${requestLabel}: AI request took more than 5 minutes; abandoning and continuing`);
            return;
          }
          console.error(`${requestLabel} failed:`, error);
          throw error;
        }
      }),
    );
  }

  return ok;
}

async function drainQueue<T, Id extends string | number>(
  fetchPage: (limit: number, excludeIds: Id[]) => Promise<T[]>,
  idOf: (item: T) => Id,
  batchSize: number,
  concurrency: number,
  label: string,
  processBatch: (batch: T[], requestLabel: string) => Promise<boolean>,
): Promise<boolean> {
  const excludeIds: Id[] = [];
  let cycle = 0;
  let ok = true;

  while (true) {
    const limit = Math.max(1, concurrency) * batchSize;
    const page = await fetchPage(limit, excludeIds);
    if (page.length === 0) {
      console.log(`${label}: no items remaining`);
      break;
    }

    for (const item of page) {
      excludeIds.push(idOf(item));
    }
    cycle += 1;
    const chunks = batchArray(page, batchSize);
    console.log(`${label}: cycle ${cycle}, ${page.length} items in ${chunks.length} batches`);
    const waveOk = await runWaves(chunks, concurrency, `${label} cycle ${cycle}`, processBatch);
    if (!waveOk) {
      ok = false;
    }
  }

  return ok;
}

async function processInflections(
  puzzleId: string,
  provider: IAiProvider,
  promptTemplate: string,
  concurrency: number,
): Promise<boolean> {
  let entries = await getPuzzleEntriesForInflections(puzzleId);
  console.log(`Step 1: ${entries.length} entries without loading_status I*`);
  if (entries.length === 0) {
    return true;
  }

  const unparsed = entries.filter((entry) => !(entry.reviewedStatus ?? '').startsWith('1'));
  if (unparsed.length > 0) {
    console.log(`Step 1: running entry parser on ${unparsed.length} entries without reviewed_status 1*`);
    const timedOut = await parseProvidedEntries(
      unparsed.map((entry) => ({ entry: entry.entry, lang: entry.lang })),
      provider,
      concurrency,
    );
    if (timedOut) {
      console.warn('Step 1: entry parser timed out; leaving inflections for retry');
      return false;
    }
    entries = await getPuzzleEntriesForInflections(puzzleId);
    if (entries.length === 0) {
      console.log('Step 1: no entries remaining after entry parser');
      return true;
    }
  }

  await resetPuzzleClueMatchAttemptedForEntries(puzzleId, entries);
  console.log(`Step 1: reset match_attempted for clues of ${entries.length} entries`);
  return runWaves(
    batchArray(entries, ENTRIES_PER_INFLECTION_PROMPT),
    concurrency,
    'Step 1 inflections',
    (batch, requestLabel) => processInflectionBatch(batch, provider, promptTemplate, requestLabel),
  );
}

const SENSE_ADD_HEADER = /^ADD\s*\(([^,)]+),\s*([^)]+)\)\s*(.+)$/i;
const SENSE_PAIR_CHANGE = /^(COMBINE|IMPROVE)\s*:?\s+(.+?)\s*\|\s*(.+)$/i;
const SENSE_ADD_FIELD = /^(Regionality|Natural|Colloquial|Alternatives)\s*:\s*(.*)$/i;

function splitSenseListField(text: string): string[] {
  const trimmed = text.trim();
  const separator = trimmed.includes(';') ? ';' : ',';
  return trimmed
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item !== '' && item.toLowerCase() !== '(none)');
}

function parseSenseSummaryLine(line: string): { summary: string; definition: string } {
  const spacedIndex = line.indexOf(' : ');
  const colonIndex = spacedIndex !== -1 ? spacedIndex : line.indexOf(':');
  if (colonIndex === -1) {
    return { summary: line.trim(), definition: '' };
  }
  const separatorLength = spacedIndex !== -1 ? 3 : 1;
  return {
    summary: line.slice(0, colonIndex).trim(),
    definition: line.slice(colonIndex + separatorLength).trim(),
  };
}

export function parseSenseChangesResponse(response: string): ParsedSenseChanges {
  const lines = response
    .replace(/```(?:\w+)?/g, '')
    .split('\n')
    .map((line) => line.replace(/\*\*/g, '').replace(/^[-*]\s+/, '').trim())
    .filter((line) => line !== '');
  const changes: ParsedSenseChanges = { adds: [], combines: [], improves: [] };
  let current: ParsedSenseAdd | null = null;
  let hasFields = false;

  const finishAdd = () => {
    if (current && current.summary) {
      const isLiteral = current.summary.toLowerCase() === 'literal';
      const isPersonalName = current.summary.toLowerCase() === PERSONAL_NAME_SUMMARY.toLowerCase();
      changes.adds.push({
        ...current,
        summary: isLiteral ? 'Literal' : isPersonalName ? PERSONAL_NAME_SUMMARY : current.summary,
        definition: isLiteral ? '' : isPersonalName ? PERSONAL_NAME_SUMMARY : current.definition,
      });
    }
    current = null;
    hasFields = false;
  };

  for (const line of lines) {
    const addMatch = line.match(SENSE_ADD_HEADER);
    if (addMatch) {
      finishAdd();
      current = {
        partOfSpeech: addMatch[1].trim(),
        classification: addMatch[2].trim(),
        displayText: addMatch[3].trim(),
        summary: '',
        definition: '',
        naturalTranslations: [],
        colloquialTranslations: [],
        alternatives: [],
      };
      continue;
    }

    const pairMatch = line.match(SENSE_PAIR_CHANGE);
    if (pairMatch) {
      finishAdd();
      const first = pairMatch[2].trim();
      const second = pairMatch[3].trim();
      if (!first || !second) {
        continue;
      }
      if (pairMatch[1].toUpperCase() === 'COMBINE') {
        changes.combines.push({ first, second });
      } else {
        changes.improves.push({ oldSummary: first, newSummary: second });
      }
      continue;
    }

    if (!current) {
      continue;
    }
    const add: ParsedSenseAdd = current;

    const fieldMatch = line.match(SENSE_ADD_FIELD);
    if (fieldMatch) {
      hasFields = true;
      const value = fieldMatch[2];
      switch (fieldMatch[1].toLowerCase()) {
        case 'regionality': {
          const regionality = parseRegionalityValue(value);
          if (regionality) {
            add.regionality = regionality;
          }
          break;
        }
        case 'natural':
          add.naturalTranslations = splitSenseListField(value);
          break;
        case 'colloquial':
          add.colloquialTranslations = splitSenseListField(value);
          break;
        case 'alternatives':
          add.alternatives = splitSenseListField(value);
          break;
      }
      continue;
    }

    if (!add.summary) {
      const { summary, definition } = parseSenseSummaryLine(line);
      add.summary = summary;
      add.definition = definition;
    } else if (!hasFields) {
      add.definition = `${add.definition} ${line}`.trim();
    }
  }
  finishAdd();

  return changes;
}

function generatedSenseRow(
  parsed: ParsedSenseAdd,
  id: string,
  item: PuzzleEntryForSenseGeneration,
  entry: string,
): GeneratedSenseInsert {
  const translationLang = item.lang === 'en' ? 'es' : 'en';
  const isLiteral = parsed.summary.trim().toLowerCase() === 'literal';
  const cleanList = (values: string[]) =>
    values.map(removeParenthesizedComments).filter((text) => text !== '');
  const natural = cleanList(parsed.naturalTranslations);
  const colloquial = cleanList(parsed.colloquialTranslations);

  return {
    id,
    entry,
    lang: item.lang,
    display_text: parsed.displayText,
    summary: isLiteral ? 'Literal' : parsed.summary,
    definition: isLiteral ? '' : parsed.definition,
    part_of_speech: parsed.partOfSpeech,
    classification: parsed.classification,
    similar_entries: cleanList(parsed.alternatives),
    tags: parsed.regionality
      ? [{ tag: 'regionality', value: parsed.regionality }]
      : [],
    translations: natural.length > 0 || colloquial.length > 0
      ? [{
          translation_lang: translationLang,
          natural_translations: natural,
          colloquial_translations: colloquial,
        }]
      : [],
  };
}

/**
 * The senses prompt can return senses for the item itself or for one of its base forms; the display text
 * of each sense says which. Returns null when the display text's letters and digits match neither.
 */
export function senseTargetEntry(
  displayText: string,
  itemEntry: string,
  baseEntries: string[],
): string | null {
  const key = displayTextToEntry(displayText);
  if (key === itemEntry || baseEntries.includes(key)) {
    return key;
  }
  return null;
}

function pickSenseToKeep(
  first: SenseGenerationExistingSense,
  second: SenseGenerationExistingSense,
  itemEntry: string,
): [keep: SenseGenerationExistingSense, remove: SenseGenerationExistingSense] {
  const progress = (sense: SenseGenerationExistingSense) => (sense.reviewedStatus ?? '').length;
  if (progress(second) !== progress(first)) {
    return progress(second) > progress(first) ? [second, first] : [first, second];
  }
  if (first.entry === itemEntry && second.entry !== itemEntry) {
    return [second, first];
  }
  return [first, second];
}

async function applySenseChanges(
  item: PuzzleEntryForSenseGeneration,
  changes: ParsedSenseChanges,
  requestLabel: string,
): Promise<void> {
  const senses = item.existingSenses
    .filter((sense) => sense.summary !== '')
    .map((sense) => ({ ...sense }));
  const removedIds = new Set<string>();
  const findSense = (summary: string, excludeId?: string) => {
    const trimmed = summary.trim();
    const lower = trimmed.toLowerCase();
    const pool = senses.filter((sense) => !removedIds.has(sense.id) && sense.id !== excludeId);
    return pool.find((sense) => sense.summary === trimmed)
      ?? pool.find((sense) => sense.summary.toLowerCase() === lower)
      ?? null;
  };
  const describe = (entry: string, summary: string) =>
    entry === item.entry ? `"${summary}"` : `"${summary}" (on base form ${entry})`;

  const merges: SenseMerge[] = [];
  for (const combine of changes.combines) {
    const first = findSense(combine.first);
    const second = first ? findSense(combine.second, first.id) : null;
    if (!first || !second) {
      console.warn(
        `${requestLabel}: COMBINE "${combine.first}" | "${combine.second}" ` +
          `does not match two existing senses of ${item.entry}; skipping`,
      );
      continue;
    }
    const [keep, remove] = pickSenseToKeep(first, second, item.entry);
    removedIds.add(remove.id);
    merges.push({ keepId: keep.id, removeId: remove.id });
    console.log(
      `${requestLabel}: COMBINE keeping ${describe(keep.entry, keep.summary)}, ` +
        `removing ${describe(remove.entry, remove.summary)}`,
    );
  }

  const summaryUpdates = new Map<string, SenseSummaryUpdate>();
  for (const improve of changes.improves) {
    const sense = findSense(improve.oldSummary);
    const newSummary = improve.newSummary.trim();
    if (!sense) {
      console.warn(
        `${requestLabel}: IMPROVE "${improve.oldSummary}" does not match an existing sense of ${item.entry}; skipping`,
      );
      continue;
    }
    if (newSummary === sense.summary) {
      continue;
    }
    console.log(`${requestLabel}: IMPROVE ${describe(sense.entry, sense.summary)} -> "${newSummary}"`);
    sense.summary = newSummary;
    summaryUpdates.set(sense.id, { senseId: sense.id, summary: newSummary });
  }

  const inserts: GeneratedSenseInsert[] = [];
  for (const add of changes.adds) {
    const targetEntry = senseTargetEntry(add.displayText, item.entry, item.baseEntries);
    if (!targetEntry) {
      console.warn(
        `${requestLabel}: ADD "${add.summary}" has display text "${add.displayText}" that does not match ` +
          `${[item.entry, ...item.baseEntries].join(' or ')} letter for letter; skipping`,
      );
      continue;
    }
    const lower = add.summary.toLowerCase();
    const duplicate =
      senses.some((sense) =>
        !removedIds.has(sense.id) && sense.entry === targetEntry && sense.summary.toLowerCase() === lower)
      || inserts.some((row) => row.entry === targetEntry && row.summary.toLowerCase() === lower);
    if (duplicate) {
      console.log(`${requestLabel}: ADD ${describe(targetEntry, add.summary)} already exists; skipping`);
      continue;
    }
    const row = generatedSenseRow(add, generateId(), item, targetEntry);
    inserts.push(row);
    console.log(
      `${requestLabel}: ADD ${describe(targetEntry, row.summary)}` +
        `${add.regionality ? ` [regionality=${add.regionality}]` : ''}`,
    );
  }

  await insertGeneratedSenses(inserts);
  await mergeSenses(merges);
  await updateSenseSummaries([...summaryUpdates.values()]);
  console.log(
    `${requestLabel}: applied ${inserts.length} adds, ${merges.length} combines, ` +
      `${summaryUpdates.size} improvements for ${item.entry}`,
  );
}

async function generateSensesForEntry(
  item: PuzzleEntryForSenseGeneration,
  provider: IAiProvider,
  promptTemplate: string,
  requestLabel: string,
): Promise<boolean> {
  const displayTexts = entryDisplayTexts(item);
  const translationLang = item.lang === 'en' ? 'es' : 'en';
  const existingSenses = item.existingSenses
    .filter((sense) => sense.summary !== '')
    .map((sense) => `${sense.partOfSpeech || 'unknown'} | ${sense.displayText || sense.entry} | ${sense.summary}`);
  const hints = uniqueInOrder(item.hints.map(cluePromptText));
  const baseForms = uniqueInOrder(item.baseDisplays.map((text) => text.trim()));
  const prompt = fillPrompt(promptTemplate, {
    '[[ITEM]]': displayTexts.join('/'),
    '[[SOURCE_LANGUAGE]]': LanguageNames[item.lang] ?? item.lang,
    '[[TRANSLATION_LANGUAGE]]': LanguageNames[translationLang] ?? translationLang,
    '[[BASE FORMS]]': baseForms.length > 0 ? baseForms.join('\n') : '(None)',
    '[[REFERENCE SENSES]]': existingSenses.length > 0 ? existingSenses.join('\n') : '(None)',
    '[[HINT]]': hints.length > 0 ? hints.join('\n') : '(None)',
  });

  console.log(
    `${requestLabel}: generating senses for ${item.entry} (${item.lang}) ` +
      `forms=${displayTexts.join('/')} base=${baseForms.join('/') || '(none)'} ` +
      `existing=${existingSenses.length} hints=${JSON.stringify(hints)}`,
  );

  const response = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: received response (${response.length} characters)`);
  if (response.replace(/```(?:\w+)?/g, '').trim().toLowerCase() === 'nonsense') {
    console.log(`${requestLabel}: ${item.entry} returned Nonsense`);
    return true;
  }

  const changes = parseSenseChangesResponse(response);
  const changeCount = changes.adds.length + changes.combines.length + changes.improves.length;
  console.log(
    `${requestLabel}: parsed ${changes.adds.length} ADD, ${changes.combines.length} COMBINE, ` +
      `${changes.improves.length} IMPROVE for ${item.entry}`,
  );
  if (changeCount === 0) {
    if (existingSenses.length === 0) {
      console.warn(`${requestLabel}: no senses parsed for ${item.entry}; leaving for retry`);
      return false;
    }
    console.log(`${requestLabel}: no changes to existing senses of ${item.entry}`);
    return true;
  }

  await applySenseChanges(item, changes, requestLabel);
  return true;
}

async function generateSenses(
  puzzleId: string,
  provider: IAiProvider,
  promptTemplate: string,
  concurrency: number,
): Promise<boolean> {
  const items = await getPuzzleEntriesForSenseGeneration(puzzleId);
  console.log(`Step 3: ${items.length} entries with unmatched clues`);
  if (items.length === 0) {
    return true;
  }

  return runWaves(items, concurrency, 'Step 3 senses', (item, requestLabel) =>
    generateSensesForEntry(item, provider, promptTemplate, requestLabel),
  );
}

async function matchClueChunk(
  clues: PuzzleClueForProcessing[],
  provider: IAiProvider,
  promptTemplate: string,
  requestLabel: string,
  finalPass: boolean,
): Promise<boolean> {
  if (clues.length === 0) {
    return true;
  }
  const prompt = fillPrompt(promptTemplate, {
    '[[DATA]]': clues.map((clue) => buildClueGroup(clue)).join('\n\n'),
  });
  console.log(`${requestLabel}: sending crossword matching prompt for ${clues.length} clues`);

  const response = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: received response (${response.length} characters)`);
  const parsed = parseCrosswordMatchingResponse(response, clues);
  console.log(`${requestLabel}: parsed ${parsed.size} of ${clues.length} clue matches`);

  const outcomes: MatchOutcome[] = clues.map((clue) => {
    const result = parsed.get(clue.clueId);
    if (!result) {
      return { kind: 'unparsed', clue };
    }
    if (result.kind === 'unclear') {
      return { kind: 'unclear', clue };
    }
    const sense = matchSenseFromPromptResult(clue.senses, result.summary, result.naturalForm, clue.entry);
    return sense ? { kind: 'matched', clue, sense } : { kind: 'unmatched', clue, summary: result.summary };
  });

  const unmatchedAction = finalPass ? 'leaving sense_id null' : 'will generate senses';
  const updates: ClueSenseMatchUpdate[] = [];
  for (const outcome of outcomes) {
    const { clue } = outcome;
    switch (outcome.kind) {
      case 'unparsed':
        console.warn(
          `${requestLabel}: no parseable match for clue ${clue.clueId} (${clue.entry}); ` +
            `${finalPass ? 'leaving for retry' : 'will generate senses'}`,
        );
        continue;
      case 'unclear':
        console.log(`${requestLabel}: ${clue.entry}: Unclear; ${unmatchedAction}`);
        if (finalPass) {
          updates.push({ clueId: clue.clueId, senseId: null, matchAttempted: true });
        }
        continue;
      case 'unmatched':
        console.log(`${requestLabel}: ${clue.entry}: no existing sense for "${outcome.summary}"; ${unmatchedAction}`);
        if (finalPass) {
          updates.push({ clueId: clue.clueId, senseId: null, matchAttempted: true });
        }
        continue;
      case 'matched':
        console.log(
          `${requestLabel}: ${clue.entry}: matched sense ${outcome.sense.id} "${outcome.sense.summary}"` +
            `${outcome.sense.entry !== clue.entry ? ` on ${outcome.sense.entry}` : ''}`,
        );
        updates.push({ clueId: clue.clueId, senseId: outcome.sense.id, matchAttempted: true });
    }
  }

  await updateClueSenseMatches(updates);
  return !finalPass || outcomes.every((outcome) => outcome.kind !== 'unparsed');
}

/**
 * The first pass only records successful matches; unmatched clues keep match_attempted = false so that sense
 * generation can target them. The final pass gives up on anything still unmatched.
 */
async function matchClues(
  puzzleId: string,
  provider: IAiProvider,
  promptTemplate: string,
  concurrency: number,
  finalPass: boolean,
): Promise<boolean> {
  const label = finalPass ? 'Step 4' : 'Step 2';
  const clues = await getPuzzleCluesForProcessing(puzzleId);
  const pending = clues.filter((clue) => !clue.matchAttempted);
  console.log(`${label}: ${pending.length} of ${clues.length} clues need matching`);

  const withoutSenses = pending.filter((clue) => !clue.entryExists || clue.senses.length === 0);
  if (withoutSenses.length > 0) {
    if (finalPass) {
      await updateClueSenseMatches(withoutSenses.map((clue) => ({
        clueId: clue.clueId,
        senseId: null,
        matchAttempted: true,
      })));
      console.log(`${label}: ${withoutSenses.length} clues have no senses to match; leaving sense_id null`);
    } else {
      console.log(`${label}: ${withoutSenses.length} clues have no senses to match yet; will generate senses`);
    }
  }

  const matchable = pending.filter((clue) => clue.entryExists && clue.senses.length > 0);
  if (matchable.length === 0) {
    return true;
  }
  const chunks = batchArray(matchable, CLUES_PER_MATCH_PROMPT);
  console.log(`${label}: ${matchable.length} clues in ${chunks.length} prompts`);
  return runWaves(chunks, concurrency, `${label} matching`, (chunk, requestLabel) =>
    matchClueChunk(chunk, provider, promptTemplate, requestLabel, finalPass),
  );
}

type ScoringState = {
  senseId: string;
  displayText: string;
  summary: string;
  classification: string;
  unityBucket: string | null;
  familiarityBucket: string | null;
  qualityBucket: string | null;
  reviewedStatus: string | null;
};

function scoringState(item: PuzzleSenseScoringItem): ScoringState {
  return {
    senseId: item.senseId,
    displayText: item.displayText?.trim() || item.entry,
    summary: item.summary?.trim() || item.displayText?.trim() || item.entry,
    classification: item.classification?.trim() || 'Word',
    unityBucket: item.unityBucket,
    familiarityBucket: item.familiarityBucket,
    qualityBucket: item.qualityBucket,
    reviewedStatus: item.reviewedStatus,
  };
}

function unityLine(state: ScoringState): string {
  return `${state.displayText} (${state.summary})`;
}

function familiarityLine(state: ScoringState): string {
  return `${state.displayText} (${state.classification}) (${state.unityBucket}) (${state.summary})`;
}

function qualityLine(state: ScoringState): string {
  return `${state.displayText} (${state.unityBucket}) (${state.familiarityBucket}) (${state.summary})`;
}

async function requestBucketRatings(
  template: string,
  states: ScoringState[],
  lineFor: (state: ScoringState) => string,
  allowed: Set<string>,
  provider: IAiProvider,
  requestLabel: string,
): Promise<Map<string, BucketRating>> {
  if (states.length === 0) {
    return new Map();
  }
  const inputs = states.map((state) => ({
    state,
    promptLine: lineFor(state),
    displayText: state.displayText,
    summary: state.summary,
  }));
  const prompt = fillPrompt(template, { '[[DATA]]': inputs.map((input) => input.promptLine).join('\n') });
  console.log(`${requestLabel}: sending prompt for ${states.length} senses`);
  const response = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: received response (${response.length} characters)`);
  const ratings = parseSenseBucketResponse(response, allowed);
  console.log(`${requestLabel}: parsed ${ratings.length} ratings`);

  const matches = matchParsedResultsByIdentity(
    inputs,
    ratings,
    (input) => [input.promptLine, `${input.displayText} (${input.summary})`, input.displayText],
    (rating) => [rating.parsedForm],
  );
  const buckets = new Map<string, BucketRating>();
  for (const match of matches) {
    if (match) {
      buckets.set(match.input.state.senseId, match.parsed);
    }
  }
  return buckets;
}

async function scoreSenseBatch(
  items: PuzzleSenseScoringItem[],
  provider: IAiProvider,
  prompts: { unity: string; familiarity: string; quality: string },
  requestLabel: string,
): Promise<boolean> {
  const states = items.map(scoringState);

  const needUnity = states.filter((state) => state.reviewedStatus == null);
  if (needUnity.length > 0) {
    const buckets = await requestBucketRatings(
      prompts.unity,
      needUnity,
      unityLine,
      SENSE_UNITY_BUCKETS,
      provider,
      `${requestLabel} unity`,
    );
    const updates = [];
    for (const state of needUnity) {
      const bucket = buckets.get(state.senseId)?.bucket;
      if (!bucket) {
        console.warn(`${requestLabel}: no unity rating for ${state.displayText} (${state.senseId})`);
        continue;
      }
      state.unityBucket = bucket;
      state.reviewedStatus = '2';
      updates.push({ senseId: state.senseId, unityBucket: bucket, reviewedStatus: '2' });
      console.log(`${requestLabel}: ${state.displayText} unity=${bucket}, reviewed_status=2`);
    }
    await updateSenseScoringResults(updates);
  }

  const needFamiliarity = states.filter((state) => state.reviewedStatus === '2' && Boolean(state.unityBucket));
  if (needFamiliarity.length > 0) {
    const buckets = await requestBucketRatings(
      prompts.familiarity,
      needFamiliarity,
      familiarityLine,
      SENSE_FAMILIARITY_BUCKETS,
      provider,
      `${requestLabel} familiarity`,
    );
    const updates = [];
    for (const state of needFamiliarity) {
      const rating = buckets.get(state.senseId);
      if (!rating) {
        console.warn(`${requestLabel}: no familiarity rating for ${state.displayText} (${state.senseId})`);
        continue;
      }
      state.familiarityBucket = rating.bucket;
      state.reviewedStatus = '23';
      updates.push({
        senseId: state.senseId,
        familiarityBucket: rating.bucket,
        reviewedStatus: '23',
        domain: rating.domain ?? '',
      });
      console.log(
        `${requestLabel}: ${state.displayText} familiarity=${rating.bucket}` +
          `${rating.domain ? `, domain=${rating.domain}` : ''}, reviewed_status=23`,
      );
    }
    await updateSenseScoringResults(updates);
  }

  const needQuality = states.filter(
    (state) => state.reviewedStatus === '23' && Boolean(state.unityBucket) && Boolean(state.familiarityBucket),
  );
  if (needQuality.length > 0) {
    const buckets = await requestBucketRatings(
      prompts.quality,
      needQuality,
      qualityLine,
      SENSE_QUALITY_BUCKETS,
      provider,
      `${requestLabel} quality`,
    );
    const updates = [];
    for (const state of needQuality) {
      const rating = buckets.get(state.senseId);
      if (!rating) {
        console.warn(`${requestLabel}: no quality rating for ${state.displayText} (${state.senseId})`);
        continue;
      }
      state.qualityBucket = rating.bucket;
      state.reviewedStatus = '234';
      updates.push({
        senseId: state.senseId,
        qualityBucket: rating.bucket,
        reviewedStatus: '234',
        flags: rating.flags,
      });
      console.log(
        `${requestLabel}: ${state.displayText} quality=${rating.bucket}, reviewed_status=234` +
          `${rating.flags.length > 0 ? `, tags=${rating.flags.join(',')}` : ''}`,
      );
    }
    await updateSenseScoringResults(updates);
  }

  const scored = states.filter((state) => state.reviewedStatus === '234');
  if (scored.length > 0) {
    await fillEntryFieldsFromScoredSenses(scored.map((state) => ({ senseId: state.senseId })));
    console.log(`${requestLabel}: updated entry records from ${scored.length} scored senses where eligible`);
  }

  const unfinished = states.length - scored.length;
  if (unfinished > 0) {
    console.warn(`${requestLabel}: ${unfinished} senses still need scoring`);
  }
  return unfinished === 0;
}

async function processReferenceBatch(
  items: PuzzleSenseReferenceItem[],
  provider: IAiProvider,
  promptTemplate: string,
  requestLabel: string,
): Promise<boolean> {
  if (items.length === 0) {
    return true;
  }
  const inputs = items.map((item) => ({
    item,
    line: `${item.displayText?.trim() || item.entry} : ${item.summary?.trim() || ''}`,
    displayText: item.displayText?.trim() || item.entry,
    summary: item.summary?.trim() || '',
  }));
  const prompt = fillPrompt(promptTemplate, {
    '[[DATA]]': inputs.map((input) => input.line).join('\n'),
  });
  await deleteSenseReferences(items.map((item) => item.senseId));
  console.log(`${requestLabel}: deleted existing references for ${items.length} senses`);
  console.log(`${requestLabel}: sending sense reference prompt for ${items.length} senses`);

  const response = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: received response (${response.length} characters)`);
  const parsed = parseSenseReferenceResponse(response);
  console.log(`${requestLabel}: parsed ${parsed.length} reference blocks`);
  const matches = matchParsedResultsByIdentity(
    inputs,
    parsed,
    (input) => [input.line, input.displayText, `${input.displayText} : ${input.summary}`],
    (block) => [block.item, `${block.item} : ${block.summary}`],
  );

  const references = [];
  const processedSenseIds: string[] = [];
  for (const match of matches) {
    if (!match) {
      continue;
    }
    processedSenseIds.push(match.input.item.senseId);
    for (const reference of match.parsed.references) {
      references.push({
        id: generateId(),
        senseId: match.input.item.senseId,
        referenceType: reference.type,
        referenceText: reference.text,
        referenceSource: reference.source,
        referenceUrl: reference.url,
      });
    }
    console.log(
      `${requestLabel}: ${match.input.displayText} "${match.input.summary}" ` +
        `-> ${match.parsed.references.length} references`,
    );
  }

  const unmatched = inputs.length - processedSenseIds.length;
  if (unmatched > 0) {
    console.warn(`${requestLabel}: ${unmatched} senses had no reference block`);
  }

  await insertSenseReferences(references);
  await markSensesReferencesAttempted(items.map((item) => item.senseId));
  return true;
}

async function processLoreBatch(
  items: PuzzleSenseLoreItem[],
  provider: IAiProvider,
  promptTemplate: string,
  requestLabel: string,
): Promise<boolean> {
  if (items.length === 0) {
    return true;
  }
  const inputs = items.map((item) => ({
    item,
    line: `${item.displayText?.trim() || item.entry} : ${item.summary?.trim() || ''}`,
    displayText: item.displayText?.trim() || item.entry,
    summary: item.summary?.trim() || '',
  }));
  const prompt = fillPrompt(promptTemplate, {
    '[[DATA]]': inputs.map((input) => input.line).join('\n'),
  });
  await deleteSenseLore(items.map((item) => item.senseId));
  console.log(`${requestLabel}: deleted existing lore for ${items.length} senses`);
  console.log(`${requestLabel}: sending sense lore prompt for ${items.length} senses`);

  const response = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: received response (${response.length} characters)`);
  const parsed = parseSenseLoreResponse(response, inputs.map((input) => input.line));
  console.log(`${requestLabel}: parsed ${parsed.length} lore blocks`);
  const matches = matchParsedResultsByIdentity(
    inputs,
    parsed,
    (input) => [input.line, input.displayText, `${input.displayText} : ${input.summary}`],
    (block) => [block.item, `${block.item} : ${block.summary}`],
  );

  const loreRows = [];
  let matchedCount = 0;
  for (const match of matches) {
    if (!match) {
      continue;
    }
    matchedCount += 1;
    const { loreText } = match.parsed;
    if (!loreText) {
      console.warn(`${requestLabel}: ${match.input.displayText} "${match.input.summary}" -> incomplete lore; skipping`);
      continue;
    }
    loreRows.push({
      senseId: match.input.item.senseId,
      loreText,
    });
    console.log(`${requestLabel}: ${match.input.displayText} "${match.input.summary}" -> lore`);
  }

  const unmatched = inputs.length - matchedCount;
  if (unmatched > 0) {
    console.warn(`${requestLabel}: ${unmatched} senses had no lore block`);
  }

  await insertSenseLore(loreRows);
  await markSensesLoreAttempted(items.map((item) => item.senseId));
  return true;
}

async function processPuzzle(
  puzzleId: string,
  provider: IAiProvider,
  concurrency: number,
): Promise<boolean> {
  const inflectionsPrompt = await readPrompt('./src/ai/inflections_prompt.txt');
  const sensesPrompt = await readPrompt('./src/ai/senses_prompt.txt');
  const matchingPrompt = await readPrompt('./src/ai/crossword_matching_prompt.txt');
  const unityPrompt = await readPrompt('./src/ai/sense_unity_prompt.txt');
  const familiarityPrompt = await readPrompt('./src/ai/sense_familiarity_prompt.txt');
  const qualityPrompt = await readPrompt('./src/ai/sense_quality_prompt.txt');
  const referencePrompt = await readPrompt('./src/ai/sense_reference_prompt.txt');
  const lorePrompt = await readPrompt('./src/ai/sense_lore_prompt.txt');

  const steps: Array<[string, () => Promise<boolean>]> = [
    ['Step 1: generating inflections', () =>
      processInflections(puzzleId, provider, inflectionsPrompt, concurrency)],
    ['Step 2: matching clues to existing senses', () =>
      matchClues(puzzleId, provider, matchingPrompt, concurrency, false)],
    ['Step 3: generating senses for unmatched clues', () =>
      generateSenses(puzzleId, provider, sensesPrompt, concurrency)],
    ['Step 4: re-matching unmatched clues', () =>
      matchClues(puzzleId, provider, matchingPrompt, concurrency, true)],
    ['Step 5: scoring matched senses', () =>
      drainQueue<PuzzleSenseScoringItem, string>(
        (limit, excludeIds) => getMatchedSensesForScoring(puzzleId, limit, excludeIds),
        (item) => item.senseId,
        SCORING_BATCH_SIZE,
        concurrency,
        'Step 5 sense scoring',
        (batch, requestLabel) => scoreSenseBatch(batch, provider, {
          unity: unityPrompt,
          familiarity: familiarityPrompt,
          quality: qualityPrompt,
        }, requestLabel),
      )],
    ['Step 6: finding sense references', () =>
      drainQueue<PuzzleSenseReferenceItem, string>(
        (limit, excludeIds) => getMatchedSensesWithoutReferences(puzzleId, limit, excludeIds),
        (item) => item.senseId,
        REFERENCES_PER_PROMPT,
        concurrency,
        'Step 6 sense references',
        (batch, requestLabel) => processReferenceBatch(batch, provider, referencePrompt, requestLabel),
      )],
    ['Step 7: generating sense lore', () =>
      drainQueue<PuzzleSenseLoreItem, string>(
        (limit, excludeIds) => getMatchedSensesWithoutLore(puzzleId, limit, excludeIds),
        (item) => item.senseId,
        LORE_PER_PROMPT,
        concurrency,
        'Step 7 sense lore',
        (batch, requestLabel) => processLoreBatch(batch, provider, lorePrompt, requestLabel),
      )],
  ];

  for (const [description, run] of steps) {
    console.log(`${description} for puzzle ${puzzleId}`);
    if (!(await run())) {
      console.warn(`${description} did not complete for puzzle ${puzzleId}; stopping before later steps`);
      return true;
    }
  }

  console.log(`Finished all steps for puzzle ${puzzleId}`);
  return false;
}

export async function crosswordProcessor(
  provider: IAiProvider = cursorProvider,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
): Promise<void> {
  const concurrency = Math.max(1, parallelRequests);
  console.log(
    `Starting crossword processor with provider ${provider.sourceAI} (${concurrency} parallel)`,
  );

  while (true) {
    const puzzleId = await pullCrosswordProcessingPuzzle();
    if (!puzzleId) {
      console.log('No puzzles remaining in crossword_processing_queue');
      break;
    }

    console.log(`Processing puzzle ${puzzleId}`);
    try {
      const needsRetry = await processPuzzle(puzzleId, provider, concurrency);
      if (needsRetry) {
        await deferCrosswordProcessingPuzzle(puzzleId);
        console.log(`Puzzle ${puzzleId} still needs processing; left it on crossword_processing_queue`);
        continue;
      }
      await deleteCrosswordProcessingPuzzle(puzzleId);
      console.log(`Removed puzzle ${puzzleId} from crossword_processing_queue`);
    } catch (error) {
      console.error(`Fatal error processing puzzle ${puzzleId}; leaving it on crossword_processing_queue:`, error);
      throw error;
    }
  }
}
