/*
This is a multistep process.
Only one puzzle_id should be processed at a time, but the clues can be processed in parallel.
All items in a given step should be completed before moving on to the next step.
Parallel processing should be handled as familiarGenerator.ts does.

STEP 1 (Inflections):
- Read a puzzle_id from crossword_processing_queue. Delete that queue row only when the puzzle has finished processing.
- Query the entry table for all entries in the puzzle whose loading_status does not start with "I".
- Send an AI query using inflections_prompt.txt (AI provider passed in as a parameter). 20 entries per query.
  - Also check entry_secondary_class for alternate display_texts. If multiple display_texts exist for an entry,
    send them to inflections_prompt.txt as separate line items.
- If the AI query returns results for an item:
  - Delete all inflected_entry rows for that item (as base_entry).
  - For any returned inflected forms and/or base forms that don't already exist in the entry table, create them using the
    display text returned by the prompt. Insert an entry_tags row with tag 'inflection_generator' for
    each newly created inflected-form or base-form entry.
  - Create new rows in inflected_entry according to the AI results. If base_form(s) were returned, create the appropriate rows
      but no need to populate the inflected_type field.
  - If a base form for the item was returned, delete all senses associated with the item.
- Set loading_status on all entries sent to AI to "I".
- For clues whose entries did not initially have loading_status starting with "I", set match_attempted to false.

STEP 2 (Sense Generation):
a. Fetch all entries for the puzzle_id and check the inflected_entry table for base forms of the entries that have no senses.
  - Base forms are inflected_entry rows where the puzzle entry is the inflected_form.
  - An entry can have multiple base forms (e.g. DOES -> DOE and DO).
b. Check each base form to see if it has reviewed_status starting with "1". If not, run them through the entryParser process to
    generate display_text, classification, and potentially entry_secondary_class records.
c. Then send the base forms to senses_prompt.txt. (One item per prompt.) I'm sending the base forms at first because their senses 
    will be necessary to generate the senses of the inflected forms.
  - As the hint in the prompt, send the clue from the puzzle associated with the inflected entry.
  - Send every different display_text of the base form to the prompt. This includes the entry's display_text and the display_text 
     of all entry_secondary_class records (deduplicate).
d. Parse the results and insert the sense information into the database.
  - If a sense comes back with summary of "Literal", insert "Literal" into the summary field and leave the definition field blank.
  - If Regionality is anything other than Widespread, insert a sense_tags row with tag "regionality" and value the region from the prompt.
e. Now repeat substeps b-d for all the actual entries in the puzzle. (not the base forms).
  - When building the senses_prompt, send the base form's senses as existing senses as well as the entry's senses.

STEP 3 (Clue Matching):
- Fetch all the clues and entries for the given puzzle_id. Include all existing senses for the entries, from both
    the entry itself and from every base form if any exist.
- Generate an AI prompt using crossword_matching_prompt.txt and fetch the results 
    (use the AIProvider passed in as a parameter). Send 10 entries per prompt.
  - Include senses from both the entry itself and from every base form if any exist.
  - A clue's sense_id can point to a sense of a base form entry or the entry itself. The prompt results will
      indicate the entry whose sense was matched.
- Update the clue records with the matched sense ids.
- If there are entries that could not be matched to an existing sense, or the prompt returns Unclear, 
   leave the sense_id field null for that clue.
- At the end of the step, all clues from the puzzle should have match_attempted set to true.

STEP 4 (Sense Scoring):
Loop through the steps until all eligible senses have been scored.
- Fetch a number of senses that were matched with clues for the puzzle_id and have reviewed_status not "234"
   (number to select at a time is based on the parallel processing parameters).
- Run the items through a pipeline of sense_unity_prompt.txt, sense_familiarity_prompt.txt, and sense_quality_prompt.txt. 
   Take inspiration from unityGenerator.ts, familiarityGenerator.ts, and qualityGenerator.ts to implement the pipeline,
   refactoring out common code where possible to avoid code duplication. Batches of 50 per prompt.
- After the unity prompt, if the unity_bucket is Non-unit or Nonsense, delete the sense and set
   clue.sense_id back to null for that clue. 
  - Otherwise, update the reviewed_status of the sense to "2". 
- After the familiarity prompt, update the reviewed_status to "23" and set sense.domain from the parenthetical domain/area when the prompt returns one.
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
  3. Tiebreaker: highest quality_bucket: Idiomatic > Interesting > Appealing > Positive >
     Trendy > Normal > Uncommon Inflection > Clunky > Non-unit.
  4. Tiebreaker: pick one at random.

STEP 5 (Sense References):
- Fetch a number of senses that were matched with clues for the puzzle_id and have their references_attempted field set to false.
  (number to select at a time is based on the parallel processing parameters).
- Generate an AI request to sense_reference_prompt.txt with the senses. Send 10 senses per prompt.
  - Send the display text of the sense to the prompt.
- Update the sense_reference table with the new references.
- Set the references_attempted field to true for the senses that were processed.

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
  deleteSensesAndClearClueMatches,
  fillEntryFieldsFromScoredSenses,
  GeneratedSenseInsert,
  getMatchedSensesForScoring,
  getMatchedSensesWithoutReferences,
  getPuzzleCluesForProcessing,
  getPuzzleEntriesForInflections,
  getPuzzleEntriesForSenseGeneration,
  InflectionGeneratorForm,
  InflectionGeneratorResult,
  insertGeneratedSenses,
  insertSenseReferences,
  markSensesReferencesAttempted,
  pullCrosswordProcessingPuzzle,
  PuzzleClueForProcessing,
  PuzzleEntryForInflections,
  PuzzleEntryForSenseGeneration,
  PuzzleSenseForProcessing,
  PuzzleSenseReferenceItem,
  PuzzleSenseScoringItem,
  resetPuzzleClueMatchAttemptedForEntries,
  SenseGenerationExistingSense,
  updateClueSenseMatches,
  updateSenseScoringResults,
} from 'cruzi-db';
import { LanguageNames } from 'cruzi-models';
import { CursorAiProvider } from './ai/cursor';
import { IAiProvider } from './ai/IAiProvider';
import { parseProvidedEntries } from './entryParser';
import { ParsedSense, parseSensesResponse } from './sensesGenerator';
import { matchParsedResultsByIdentity } from './lib/resultMatching';
import { batchArray, displayTextToEntry, entryToAllCaps, generateId, isGeminiTimeoutError } from './lib/utils';

const CLUES_PER_MATCH_PROMPT = 10;
const ENTRIES_PER_INFLECTION_PROMPT = 20;
const REFERENCES_PER_PROMPT = 10;
const SCORING_BATCH_SIZE = 50;
const DEFAULT_PARALLEL_REQUESTS = 1;

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

const REJECTED_UNITY_BUCKETS = new Set(['Non-unit', 'Nonsense']);

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
  'Uncommon Inflection',
  'Clunky',
  'Idiomatic',
  'Interesting',
  'Appealing',
  'Positive',
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
  return fs.promises.readFile(relativePath, 'utf-8');
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
  const promptItems = entries.map((entry) => ({
    entry,
    displayTexts: entryDisplayTexts(entry),
  }));
  const lineItems = promptItems.flatMap((item) => item.displayTexts);
  const prompt = fillPrompt(promptTemplate, {
    '[[DATA]]': lineItems.join('\n'),
  });
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
          `${baseForms.length > 0 ? `, base forms ${baseForms.join(', ')} (deleting its senses)` : ''}`,
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
  const entries = await getPuzzleEntriesForInflections(puzzleId);
  console.log(`Step 1: ${entries.length} entries without loading_status I*`);
  if (entries.length === 0) {
    return true;
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

function findCorrespondingSense(
  parsed: ParsedSense,
  existing: SenseGenerationExistingSense[],
): SenseGenerationExistingSense | null {
  const corresponding = parsed.correspondingExistingSense?.trim() ?? '';
  const normalized = corresponding.toLowerCase();
  if (!corresponding || normalized === 'none' || normalized === '(none)') {
    return null;
  }
  return existing.find((sense) => sense.summary.trim() === corresponding)
    ?? existing.find((sense) => sense.summary.trim().toLowerCase() === normalized)
    ?? null;
}

function generatedSenseRow(
  parsed: ParsedSense,
  id: string,
  item: PuzzleEntryForSenseGeneration,
): GeneratedSenseInsert {
  const translationLang = item.lang === 'en' ? 'es' : 'en';
  const isLiteral = parsed.summary.trim().toLowerCase() === 'literal';
  const cleanList = (values: string[]) =>
    values.map(removeParenthesizedComments).filter((text) => text !== '');
  const natural = cleanList(parsed.naturalTranslations);
  const colloquial = cleanList(parsed.colloquialTranslations);

  return {
    id,
    entry: item.entry,
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
    .map((sense) => `${sense.displayText || sense.entry} : ${sense.summary}`);
  const prompt = fillPrompt(promptTemplate, {
    '[[ITEM]]': displayTexts.join('/'),
    '[[SOURCE_LANGUAGE]]': LanguageNames[item.lang] ?? item.lang,
    '[[TRANSLATION_LANGUAGE]]': LanguageNames[translationLang] ?? translationLang,
    '[[REFERENCE SENSES]]': existingSenses.length > 0 ? existingSenses.join('\n') : '(None)',
    '[[HINT]]': cluePromptText(item.hint) || '(None)',
  });

  console.log(
    `${requestLabel}: generating senses for ${item.entry} (${item.lang}) ` +
      `forms=${displayTexts.join('/')} existing=${existingSenses.length} hint="${item.hint ?? ''}"`,
  );

  const response = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: received response (${response.length} characters)`);
  if (response.replace(/```(?:\w+)?/g, '').trim().toLowerCase() === 'nonsense') {
    console.log(`${requestLabel}: ${item.entry} returned Nonsense`);
    return true;
  }

  const parsed = parseSensesResponse(response);
  console.log(`${requestLabel}: parsed ${parsed.length} senses for ${item.entry}`);
  if (parsed.length === 0) {
    console.warn(`${requestLabel}: no senses parsed for ${item.entry}; leaving for retry`);
    return false;
  }

  const rows = new Map<string, GeneratedSenseInsert>();
  for (const sense of parsed) {
    const corresponding = findCorrespondingSense(sense, item.existingSenses);
    if (corresponding && corresponding.entry !== item.entry) {
      console.log(
        `${requestLabel}: ${item.entry} sense "${sense.summary}" is covered by ` +
          `${corresponding.entry} "${corresponding.summary}"; not inserting`,
      );
      continue;
    }
    const id = corresponding?.id ?? generateId();
    if (!rows.has(id)) {
      rows.set(id, generatedSenseRow(sense, id, item));
    }
  }

  await insertGeneratedSenses([...rows.values()]);
  console.log(
    `${requestLabel}: inserted ${rows.size} senses for ${item.entry}: ` +
      [...rows.values()].map((row) => {
        const regionality = row.tags?.find((tag) => tag.tag === 'regionality')?.value;
        return regionality ? `${row.summary} [regionality=${regionality}]` : row.summary;
      }).join('; '),
  );
  return true;
}

async function generateSenses(
  puzzleId: string,
  baseForms: boolean,
  provider: IAiProvider,
  promptTemplate: string,
  concurrency: number,
): Promise<boolean> {
  const label = baseForms ? 'Step 2 base forms' : 'Step 2 puzzle entries';
  let items = await getPuzzleEntriesForSenseGeneration(puzzleId, baseForms);
  console.log(`${label}: ${items.length} entries without senses`);
  if (items.length === 0) {
    return true;
  }

  let ok = true;
  const unparsed = items.filter((item) => !(item.reviewedStatus ?? '').startsWith('1'));
  if (unparsed.length > 0) {
    console.log(`${label}: running entry parser on ${unparsed.length} entries`);
    const timedOut = await parseProvidedEntries(
      unparsed.map((item) => ({ entry: item.entry, lang: item.lang })),
      provider,
      concurrency,
    );
    if (timedOut) {
      ok = false;
    }
    items = await getPuzzleEntriesForSenseGeneration(puzzleId, baseForms);
  }

  const generated = await runWaves(items, concurrency, `${label} senses`, (item, requestLabel) =>
    generateSensesForEntry(item, provider, promptTemplate, requestLabel),
  );
  return ok && generated;
}

async function matchClueChunk(
  clues: PuzzleClueForProcessing[],
  provider: IAiProvider,
  promptTemplate: string,
  requestLabel: string,
): Promise<boolean> {
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

  const updates: ClueSenseMatchUpdate[] = [];
  for (const outcome of outcomes) {
    const { clue } = outcome;
    switch (outcome.kind) {
      case 'unparsed':
        console.warn(`${requestLabel}: no parseable match for clue ${clue.clueId} (${clue.entry}); leaving for retry`);
        continue;
      case 'unclear':
        console.log(`${requestLabel}: ${clue.entry}: Unclear`);
        updates.push({ clueId: clue.clueId, senseId: null, matchAttempted: true });
        continue;
      case 'unmatched':
        console.log(`${requestLabel}: ${clue.entry}: no existing sense for "${outcome.summary}"; leaving sense_id null`);
        updates.push({ clueId: clue.clueId, senseId: null, matchAttempted: true });
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
  return outcomes.every((outcome) => outcome.kind !== 'unparsed');
}

async function matchClues(
  puzzleId: string,
  provider: IAiProvider,
  promptTemplate: string,
  concurrency: number,
): Promise<boolean> {
  const clues = await getPuzzleCluesForProcessing(puzzleId);
  const pending = clues.filter((clue) => !clue.matchAttempted);
  console.log(`Step 3: ${pending.length} of ${clues.length} clues need matching`);

  const withoutSenses = pending.filter((clue) => !clue.entryExists || clue.senses.length === 0);
  if (withoutSenses.length > 0) {
    await updateClueSenseMatches(withoutSenses.map((clue) => ({
      clueId: clue.clueId,
      senseId: null,
      matchAttempted: true,
    })));
    console.log(`Step 3: ${withoutSenses.length} clues have no senses to match; leaving sense_id null`);
  }

  const matchable = pending.filter((clue) => clue.entryExists && clue.senses.length > 0);
  if (matchable.length === 0) {
    return true;
  }
  const chunks = batchArray(matchable, CLUES_PER_MATCH_PROMPT);
  console.log(`Step 3: ${matchable.length} clues in ${chunks.length} prompts`);
  return runWaves(chunks, concurrency, 'Step 3 matching', (chunk, requestLabel) =>
    matchClueChunk(chunk, provider, promptTemplate, requestLabel),
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
  let states = items.map(scoringState);

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
    const rejected: string[] = [];
    for (const state of needUnity) {
      const bucket = buckets.get(state.senseId)?.bucket;
      if (!bucket) {
        console.warn(`${requestLabel}: no unity rating for ${state.displayText} (${state.senseId})`);
        continue;
      }
      state.unityBucket = bucket;
      if (REJECTED_UNITY_BUCKETS.has(bucket)) {
        rejected.push(state.senseId);
        console.log(`${requestLabel}: ${state.displayText} unity=${bucket}; deleting sense and clearing clue sense_id`);
        continue;
      }
      state.reviewedStatus = '2';
      updates.push({ senseId: state.senseId, unityBucket: bucket, reviewedStatus: '2' });
      console.log(`${requestLabel}: ${state.displayText} unity=${bucket}, reviewed_status=2`);
    }
    await updateSenseScoringResults(updates);
    await deleteSensesAndClearClueMatches(rejected);
    states = states.filter((state) => !rejected.includes(state.senseId));
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
  const inputs = items.map((item) => ({
    item,
    line: `${item.displayText?.trim() || item.entry} : ${item.summary?.trim() || ''}`,
    displayText: item.displayText?.trim() || item.entry,
    summary: item.summary?.trim() || '',
  }));
  const prompt = fillPrompt(promptTemplate, {
    '[[DATA]]': inputs.map((input) => input.line).join('\n'),
  });
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

  const steps: Array<[string, () => Promise<boolean>]> = [
    ['Step 1: generating inflections', () =>
      processInflections(puzzleId, provider, inflectionsPrompt, concurrency)],
    ['Step 2: generating senses for base forms', () =>
      generateSenses(puzzleId, true, provider, sensesPrompt, concurrency)],
    ['Step 2: generating senses for puzzle entries', () =>
      generateSenses(puzzleId, false, provider, sensesPrompt, concurrency)],
    ['Step 3: matching clues to senses', () =>
      matchClues(puzzleId, provider, matchingPrompt, concurrency)],
    ['Step 4: scoring matched senses', () =>
      drainQueue<PuzzleSenseScoringItem, string>(
        (limit, excludeIds) => getMatchedSensesForScoring(puzzleId, limit, excludeIds),
        (item) => item.senseId,
        SCORING_BATCH_SIZE,
        concurrency,
        'Step 4 sense scoring',
        (batch, requestLabel) => scoreSenseBatch(batch, provider, {
          unity: unityPrompt,
          familiarity: familiarityPrompt,
          quality: qualityPrompt,
        }, requestLabel),
      )],
    ['Step 5: finding sense references', () =>
      drainQueue<PuzzleSenseReferenceItem, string>(
        (limit, excludeIds) => getMatchedSensesWithoutReferences(puzzleId, limit, excludeIds),
        (item) => item.senseId,
        REFERENCES_PER_PROMPT,
        concurrency,
        'Step 5 sense references',
        (batch, requestLabel) => processReferenceBatch(batch, provider, referencePrompt, requestLabel),
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
