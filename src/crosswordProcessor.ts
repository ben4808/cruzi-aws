/*
This is a multistep process.
Only one puzzle_id should be processed at a time, but the clues can be processed in parallel.
All items in a given step should be completed before moving on to the next step.
Each queue will have a puzzle_id indicator so we know which items to pull on each step.

Parallel processing should be handled as familiarGenerator.ts does.

STEP 1:
- Read a puzzle_id from crossword_processing_queue at the start. Delete that queue row only when the puzzle has finished processing.
- Fetch all the clues and entries for the given puzzle_id. Include all existing senses for the entries.
  - Look for senses both from the entry itself and from its base form if it exists. 
    Look for the entry in the inflected_entry table to find the base form.
- Take all entries from the puzzle that have no display_text, and run them through the process in entryParser.ts. 
    Refactor out the necessary code from entryParser.ts to avoid code duplication.
- If there are entries that do not have any senses, add those entries immediately to the sense_generator_queue 
    with the clue as a hint.
- For entries that have senses, generate an AI prompt using crossword_matching_prompt.txt and fetch the results 
    (use the AIProvider passed in as a parameter). Send 10 entries per prompt.
  - A clue's sense_id can point to a sense of the base form entry or the entry itself. The prompt results will
     indicate the entry whose sense was matched.
- Update the clue records with the matched sense ids.
- If there are entries that could not be matched to an existing sense, add them to the sense_generator_queue with 
    the hint as the sense summary returned by the AI for that entry. Discard the invented info other than the summary.
    - You know that an existing sense was not matched because the prompt returned an invented sense summary.
      A successful match will return an existing sense summary.
- If the prompt returns Unclear, leave the sense_id field null for that clue.
- All clues that were successfully matched with a sense or were Unclear should have match_attempted set to true.

STEP 2:
- Fetch items from the sense_generator_queue for the puzzle_id and build AI prompts with senses_prompt.txt. (One item per prompt.)
- As well as the hint, send every different display_text of the entry to the prompt. If there are already senses for the
   entry, this would be all the display_text values of the existing senses. If there are no existing senses, send the
   display_text of the entry record and all corresponding entry_secondary_class records.
- Insert the sense information into the database. Keep the same puzzle_id in memory for step 3.
- If a sense comes back with summary of "Literal", insert "Literal" into the summary field and leave the definition field blank.
- Keep track of the items that were sent through the senses prompt for the next step.

STEP 3:
- For entries processed in step 2, generate an AI prompt using crossword_matching_prompt.txt and fetch the results 
    (use the AIProvider passed in as a parameter). Send 10 entries per prompt.
- If there are entries that could not be matched to an existing sense, leave the sense_id field null for that clue.
- Update the clue records with the matched sense ids and set match_attempted to true.

STEP 4:
- Read senses matched with clues for the puzzle_id (number based on the parallel processing parameters)
  whose reviewed_status is null, "2", or "23". Skip reviewed_status "234".
  - reviewed_status null -> unity generator
  - reviewed_status "2" -> familiarity generator
  - reviewed_status "23" -> quality generator
- Run the items through a pipeline of sense_unity_prompt.txt, sense_familiarity_prompt.txt, and sense_quality_prompt.txt. 
   Take inspiration from unityGenerator.ts, familiarityGenerator.ts, and qualityGenerator.ts to implement the pipeline,
   refactoring out common code where possible to avoid code duplication.
   Send the display text of the sense. If that is null, send the display text of the entry
   the sense references.
- After the unity prompt, update the reviewed_status of the sense to "2". After the familiarity prompt, update the 
   reviewed_status to "23". After the quality prompt, update the reviewed_status to "234".
   Vulgar and Sensitive are parenthetical flags, not buckets. Replace the sense's sense_tags rows for
   'vulgar' and 'sensitive' with the flags on this result.
- Batches of 50.

STEP 5:
- Read senses matched with clues for the puzzle_id that have no records in the sense_reference table
  (number based on the parallel processing parameters).
- Generate an AI request to sense_reference_prompt.txt with the entries. Send 10 per prompt.
  Send the display text of the sense. If that is null, send the display text of the entry
  the sense references.
- Update the sense_reference table with the new references.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  ClueSenseMatchUpdate,
  deferCrosswordProcessingPuzzle,
  deleteCrosswordProcessingPuzzle,
  deleteSenseGeneratorQueueItems,
  enqueueSenseGeneratorItems,
  GeneratedSenseInsert,
  getMatchedSensesForScoring,
  getMatchedSensesWithoutReferences,
  getPuzzleCluesForProcessing,
  getSenseGeneratorQueueForPuzzle,
  insertGeneratedSenses,
  insertSenseReferences,
  pullCrosswordProcessingPuzzle,
  PuzzleClueForProcessing,
  PuzzleSenseForProcessing,
  PuzzleSenseReferenceItem,
  PuzzleSenseScoringItem,
  SenseGeneratorQueueItem,
  updateClueSenseMatches,
  updateSenseScoringResults,
} from 'cruzi-db';
import { LanguageNames } from 'cruzi-models';
import { CursorAiProvider } from './ai/cursor';
import { IAiProvider } from './ai/IAiProvider';
import { parseProvidedEntries } from './entryParser';
import { ParsedSense, parseSensesResponse } from './sensesGenerator';
import { matchParsedResultsByIdentity } from './lib/resultMatching';
import { batchArray, entryToAllCaps, generateId, isGeminiTimeoutError } from './lib/utils';

const CLUES_PER_MATCH_PROMPT = 10;
const REFERENCES_PER_PROMPT = 10;
const SCORING_BATCH_SIZE = 50;
const DEFAULT_PARALLEL_REQUESTS = 1;

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

type BucketRating = { parsedForm: string; bucket: string; flags: string[] };

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

type MatchOutcome =
  | { kind: 'unparsed'; clue: PuzzleClueForProcessing }
  | { kind: 'unclear'; clue: PuzzleClueForProcessing }
  | { kind: 'invented'; clue: PuzzleClueForProcessing; summary: string }
  | { kind: 'matched'; clue: PuzzleClueForProcessing; sense: PuzzleSenseForProcessing };

function entryKey(entry: string, lang: string): string {
  return `${lang}\0${entry}`;
}

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

export function displayTextsForSensePrompt(item: {
  entry: string;
  entryDisplayText: string | null;
  secondaryDisplays: string[];
  existingSenses: Array<{ displayText: string }>;
}): string[] {
  const senseTexts = uniqueInOrder(
    item.existingSenses.map((sense) => sense.displayText.trim()).filter(Boolean),
  );
  if (senseTexts.length > 0) {
    return senseTexts;
  }

  const entryTexts = uniqueInOrder(
    [item.entryDisplayText?.trim() ?? '', ...item.secondaryDisplays.map((text) => text.trim())].filter(Boolean),
  );
  return entryTexts.length > 0 ? entryTexts : [item.entry];
}

function buildClueGroup(clue: PuzzleClueForProcessing): string {
  const lines = [`${cluePromptText(clue.customClue)} : ${clue.entry}`];
  for (const sense of clue.senses) {
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
  if (byForm.length > 0) {
    return byForm[0];
  }
  return candidates.find((sense) => sense.entry === clueEntry) ?? candidates[0];
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
    const { bucket, flags } = splitBucketAndFlags(cleaned.slice(separatorIndex + 3));
    if (!parsedForm || !allowed.has(bucket)) {
      continue;
    }
    results.push({ parsedForm, bucket, flags });
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
): Promise<{ seen: number; ok: boolean }> {
  const excludeIds: Id[] = [];
  let seen = 0;
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
    seen += page.length;
    cycle += 1;
    const chunks = batchArray(page, batchSize);
    console.log(`${label}: cycle ${cycle}, ${page.length} items in ${chunks.length} batches`);
    const waveOk = await runWaves(chunks, concurrency, `${label} cycle ${cycle}`, processBatch);
    if (!waveOk) {
      ok = false;
    }
  }

  return { seen, ok };
}

async function persistMatchOutcomes(
  puzzleId: string,
  outcomes: MatchOutcome[],
  queueUnmatched: boolean,
): Promise<void> {
  const clueUpdates: ClueSenseMatchUpdate[] = [];
  const generatorItems: Array<{ puzzleId: string; entry: string; lang: string; hint: string | null }> = [];

  for (const outcome of outcomes) {
    if (outcome.kind === 'unparsed') {
      console.warn(
        `  no parseable match for clue ${outcome.clue.clueId} (${outcome.clue.entry}); leaving it for retry`,
      );
      continue;
    }

    if (outcome.kind === 'invented') {
      if (queueUnmatched) {
        generatorItems.push({
          puzzleId,
          entry: outcome.clue.entry,
          lang: outcome.clue.lang,
          hint: outcome.summary,
        });
        console.log(
          `  ${outcome.clue.entry}: invented sense "${outcome.summary}" queued for generation`,
        );
      } else {
        clueUpdates.push({ clueId: outcome.clue.clueId, senseId: null, matchAttempted: true });
        console.log(
          `  ${outcome.clue.entry}: no existing sense for "${outcome.summary}"; leaving sense_id null`,
        );
      }
      continue;
    }

    if (outcome.kind === 'unclear') {
      clueUpdates.push({ clueId: outcome.clue.clueId, senseId: null, matchAttempted: true });
      console.log(`  ${outcome.clue.entry}: Unclear`);
      continue;
    }

    clueUpdates.push({
      clueId: outcome.clue.clueId,
      senseId: outcome.sense.id,
      matchAttempted: true,
    });
    console.log(
      `  ${outcome.clue.entry}: matched sense ${outcome.sense.id} "${outcome.sense.summary}"` +
        `${outcome.sense.entry !== outcome.clue.entry ? ` on ${outcome.sense.entry}` : ''}`,
    );
  }

  await updateClueSenseMatches(clueUpdates);
  await enqueueSenseGeneratorItems(generatorItems);
  console.log(
    `  saved ${clueUpdates.length} clue updates, queued ${generatorItems.length} sense generations`,
  );
}

async function matchClueChunk(
  puzzleId: string,
  clues: PuzzleClueForProcessing[],
  provider: IAiProvider,
  promptTemplate: string,
  requestLabel: string,
  queueUnmatched: boolean,
): Promise<boolean> {
  const prompt = fillPrompt(promptTemplate, {
    '[[DATA]]': clues.map((clue) => buildClueGroup(clue)).join('\n\n'),
  });
  console.log(`${requestLabel}: sending crossword matching prompt for ${clues.length} clues`);

  try {
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
      if (!sense) {
        return { kind: 'invented', clue, summary: result.summary };
      }
      return { kind: 'matched', clue, sense };
    });

    await persistMatchOutcomes(puzzleId, outcomes, queueUnmatched);
    return outcomes.every((outcome) => outcome.kind !== 'unparsed');
  } catch (error) {
    if (isGeminiTimeoutError(error)) {
      console.warn(`${requestLabel}: AI request took more than 5 minutes; abandoning and continuing`);
      return false;
    }
    throw error;
  }
}

async function matchClues(
  puzzleId: string,
  clues: PuzzleClueForProcessing[],
  provider: IAiProvider,
  promptTemplate: string,
  concurrency: number,
  queueUnmatched: boolean,
  label: string,
): Promise<boolean> {
  if (clues.length === 0) {
    console.log(`${label}: no clues to match`);
    return true;
  }

  const chunks = batchArray(clues, CLUES_PER_MATCH_PROMPT);
  console.log(`${label}: ${clues.length} clues in ${chunks.length} prompts`);
  return runWaves(chunks, concurrency, label, (chunk, requestLabel) =>
    matchClueChunk(puzzleId, chunk, provider, promptTemplate, requestLabel, queueUnmatched),
  );
}

function resolveGeneratedSenseId(
  parsed: ParsedSense,
  existing: Array<{ id: string; summary: string }>,
): string {
  const corresponding = parsed.correspondingExistingSense?.trim() ?? '';
  const normalized = corresponding.toLowerCase();
  if (corresponding && normalized !== 'none' && normalized !== '(none)') {
    const match = existing.find((sense) => sense.summary.trim() === corresponding)
      ?? existing.find((sense) => sense.summary.trim().toLowerCase() === normalized);
    if (match) {
      return match.id;
    }
  }
  return generateId();
}

function dedupeGeneratedSenses(rows: GeneratedSenseInsert[]): GeneratedSenseInsert[] {
  const byId = new Map<string, GeneratedSenseInsert>();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

function generatedSenseRows(
  parsedSenses: ParsedSense[],
  item: SenseGeneratorQueueItem,
): GeneratedSenseInsert[] {
  const translationLang = item.lang === 'en' ? 'es' : 'en';
  return parsedSenses.map((parsed) => {
    const isLiteral = parsed.summary.trim().toLowerCase() === 'literal';
    const natural = parsed.naturalTranslations
      .map(removeParenthesizedComments)
      .filter((text) => text !== '');
    const colloquial = parsed.colloquialTranslations
      .map(removeParenthesizedComments)
      .filter((text) => text !== '');
    const alternatives = parsed.alternatives
      .map(removeParenthesizedComments)
      .filter((text) => text !== '');

    return {
      id: resolveGeneratedSenseId(parsed, item.existingSenses),
      entry: item.entry,
      lang: item.lang,
      display_text: parsed.displayText,
      summary: isLiteral ? 'Literal' : parsed.summary,
      definition: isLiteral ? '' : parsed.definition,
      part_of_speech: parsed.partOfSpeech,
      classification: parsed.classification,
      similar_entries: alternatives,
      translations: natural.length > 0 || colloquial.length > 0
        ? [{
            translation_lang: translationLang,
            natural_translations: natural,
            colloquial_translations: colloquial,
          }]
        : [],
    };
  });
}

async function processSenseGeneratorItem(
  item: SenseGeneratorQueueItem,
  provider: IAiProvider,
  promptTemplate: string,
  requestLabel: string,
  processedEntryKeys: Set<string>,
): Promise<boolean> {
  const displayTexts = displayTextsForSensePrompt(item);
  const translationLang = item.lang === 'en' ? 'es' : 'en';
  const referenceSenses = item.existingSenses
    .map((sense) => sense.summary.trim())
    .filter((summary) => summary !== '');
  const prompt = fillPrompt(promptTemplate, {
    '[[ITEM]]': displayTexts.join('/'),
    '[[SOURCE_LANGUAGE]]': LanguageNames[item.lang] ?? item.lang,
    '[[TRANSLATION_LANGUAGE]]': LanguageNames[translationLang] ?? translationLang,
    '[[REFERENCE SENSES]]': referenceSenses.length > 0 ? referenceSenses.join('\n') : '(None)',
    '[[HINT]]': item.hint?.trim() || '(None)',
  });

  console.log(
    `${requestLabel}: generating senses for ${item.entry} (${item.lang}) ` +
      `forms=${displayTexts.join('/')} hint="${item.hint ?? ''}"`,
  );

  try {
    const response = await provider.generateResultsAsync(prompt);
    console.log(`${requestLabel}: received response (${response.length} characters)`);
    const nonsense = response.replace(/```(?:\w+)?/g, '').trim().toLowerCase() === 'nonsense';
    if (nonsense) {
      processedEntryKeys.add(entryKey(item.entry, item.lang));
      await deleteSenseGeneratorQueueItems([item.queueId]);
      console.log(`${requestLabel}: ${item.entry} returned Nonsense`);
      return true;
    }

    const parsed = parseSensesResponse(response);
    console.log(`${requestLabel}: parsed ${parsed.length} senses for ${item.entry}`);
    if (parsed.length === 0) {
      console.warn(`${requestLabel}: no senses parsed for ${item.entry}; leaving queue item`);
      return false;
    }

    const rows = dedupeGeneratedSenses(generatedSenseRows(parsed, item));
    await insertGeneratedSenses(rows);
    await deleteSenseGeneratorQueueItems([item.queueId]);
    processedEntryKeys.add(entryKey(item.entry, item.lang));
    console.log(
      `${requestLabel}: inserted ${rows.length} senses for ${item.entry}: ` +
        rows.map((row) => row.summary).join('; '),
    );
    return true;
  } catch (error) {
    if (isGeminiTimeoutError(error)) {
      console.warn(`${requestLabel}: AI request took more than 5 minutes; abandoning and continuing`);
      return false;
    }
    throw error;
  }
}

type ScoringState = {
  senseId: string;
  entry: string;
  displayText: string;
  summary: string;
  classification: string;
  unityBucket: string | null;
  familiarityBucket: string | null;
  reviewedStatus: string | null;
};

function scoringState(item: PuzzleSenseScoringItem): ScoringState {
  return {
    senseId: item.senseId,
    entry: item.entry,
    displayText: item.displayText?.trim() || item.entry,
    summary: item.summary?.trim() || item.displayText?.trim() || item.entry,
    classification: item.classification?.trim() || 'Word',
    unityBucket: item.unityBucket,
    familiarityBucket: item.familiarityBucket,
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
  lines: string[],
  allowed: Set<string>,
  provider: IAiProvider,
  requestLabel: string,
): Promise<BucketRating[]> {
  const prompt = fillPrompt(template, { '[[DATA]]': lines.join('\n') });
  console.log(`${requestLabel}: sending prompt for ${lines.length} senses`);
  const response = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: received response (${response.length} characters)`);
  const parsed = parseSenseBucketResponse(response, allowed);
  console.log(`${requestLabel}: parsed ${parsed.length} ratings`);
  return parsed;
}

function applyBucketRatings(
  states: ScoringState[],
  ratings: BucketRating[],
  lineFor: (state: ScoringState) => string,
): Map<string, BucketRating> {
  const inputs = states.map((state) => ({
    state,
    promptLine: lineFor(state),
    displayText: state.displayText,
    summary: state.summary,
  }));
  const matches = matchParsedResultsByIdentity(
    inputs,
    ratings,
    (input) => [input.promptLine, `${input.displayText} (${input.summary})`, input.displayText],
    (rating) => [rating.parsedForm],
  );
  const buckets = new Map<string, BucketRating>();
  for (const match of matches) {
    if (!match) {
      continue;
    }
    buckets.set(match.input.state.senseId, match.parsed);
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

  try {
    const active = states.filter((state) => state.reviewedStatus !== '234');

    const needUnity = active.filter((state) => state.reviewedStatus == null);
    if (needUnity.length > 0) {
      const ratings = await requestBucketRatings(
        prompts.unity,
        needUnity.map(unityLine),
        SENSE_UNITY_BUCKETS,
        provider,
        `${requestLabel} unity`,
      );
      const buckets = applyBucketRatings(needUnity, ratings, unityLine);
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

    const needFamiliarity = active.filter(
      (state) => state.reviewedStatus === '2' && Boolean(state.unityBucket),
    );
    if (needFamiliarity.length > 0) {
      const ratings = await requestBucketRatings(
        prompts.familiarity,
        needFamiliarity.map(familiarityLine),
        SENSE_FAMILIARITY_BUCKETS,
        provider,
        `${requestLabel} familiarity`,
      );
      const buckets = applyBucketRatings(needFamiliarity, ratings, familiarityLine);
      const updates = [];
      for (const state of needFamiliarity) {
        const bucket = buckets.get(state.senseId)?.bucket;
        if (!bucket) {
          console.warn(`${requestLabel}: no familiarity rating for ${state.displayText} (${state.senseId})`);
          continue;
        }
        state.familiarityBucket = bucket;
        state.reviewedStatus = '23';
        updates.push({ senseId: state.senseId, familiarityBucket: bucket, reviewedStatus: '23' });
        console.log(`${requestLabel}: ${state.displayText} familiarity=${bucket}, reviewed_status=23`);
      }
      await updateSenseScoringResults(updates);
    }

    const needQuality = active.filter(
      (state) => state.reviewedStatus === '23' && Boolean(state.unityBucket) && Boolean(state.familiarityBucket),
    );
    if (needQuality.length > 0) {
      const ratings = await requestBucketRatings(
        prompts.quality,
        needQuality.map(qualityLine),
        SENSE_QUALITY_BUCKETS,
        provider,
        `${requestLabel} quality`,
      );
      const buckets = applyBucketRatings(needQuality, ratings, qualityLine);
      const updates = [];
      for (const state of needQuality) {
        const rating = buckets.get(state.senseId);
        if (!rating) {
          console.warn(`${requestLabel}: no quality rating for ${state.displayText} (${state.senseId})`);
          continue;
        }
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

    const unfinished = active.filter((state) => state.reviewedStatus !== '234').length;
    if (unfinished > 0) {
      console.warn(`${requestLabel}: ${unfinished} senses still need scoring`);
    }
    return unfinished === 0;
  } catch (error) {
    if (isGeminiTimeoutError(error)) {
      console.warn(`${requestLabel}: AI request took more than 5 minutes; abandoning and continuing`);
      return false;
    }
    throw error;
  }
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

  try {
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
    const matchedCount = matches.filter((match) => match != null).length;
    for (const match of matches) {
      if (!match) {
        continue;
      }
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

    const unmatched = inputs.length - matchedCount;
    if (unmatched > 0) {
      console.warn(`${requestLabel}: ${unmatched} senses had no reference block`);
    }

    await insertSenseReferences(references);
    return unmatched === 0;
  } catch (error) {
    if (isGeminiTimeoutError(error)) {
      console.warn(`${requestLabel}: AI request took more than 5 minutes; abandoning and continuing`);
      return false;
    }
    throw error;
  }
}

async function processPuzzle(
  puzzleId: string,
  provider: IAiProvider,
  concurrency: number,
): Promise<boolean> {
  const matchingPrompt = await readPrompt('./src/ai/crossword_matching_prompt.txt');
  const sensesPrompt = await readPrompt('./src/ai/senses_prompt.txt');
  const unityPrompt = await readPrompt('./src/ai/sense_unity_prompt.txt');
  const familiarityPrompt = await readPrompt('./src/ai/sense_familiarity_prompt.txt');
  const qualityPrompt = await readPrompt('./src/ai/sense_quality_prompt.txt');
  const referencePrompt = await readPrompt('./src/ai/sense_reference_prompt.txt');

  console.log(`Step 1: loading clues for puzzle ${puzzleId}`);
  let clues = await getPuzzleCluesForProcessing(puzzleId);
  console.log(`Step 1: loaded ${clues.length} clues`);

  const missingDisplay = uniqueInOrder(
    clues
      .filter((clue) => clue.entryExists && (clue.displayText == null || clue.displayText.trim() === ''))
      .map((clue) => entryKey(clue.entry, clue.lang)),
  ).map((key) => {
    const separator = key.indexOf('\0');
    return { lang: key.slice(0, separator), entry: key.slice(separator + 1) };
  });

  let needsRetry = false;
  if (missingDisplay.length > 0) {
    console.log(`Step 1: parsing display text for ${missingDisplay.length} entries`);
    const timedOut = await parseProvidedEntries(missingDisplay, provider, concurrency);
    if (timedOut) {
      needsRetry = true;
    }
    clues = await getPuzzleCluesForProcessing(puzzleId);
    console.log('Step 1: reloaded clues after entry parsing');
  }

  const pending = clues.filter((clue) => !clue.matchAttempted);
  const missingEntries = pending.filter((clue) => !clue.entryExists);
  for (const clue of missingEntries) {
    console.warn(`Step 1: clue ${clue.clueId} entry ${clue.entry} (${clue.lang}) has no entry row; skipping`);
  }

  const withoutSenses = pending.filter((clue) => clue.entryExists && clue.senses.length === 0);
  if (withoutSenses.length > 0) {
    console.log(`Step 1: queueing ${withoutSenses.length} clues that have no senses`);
    await enqueueSenseGeneratorItems(withoutSenses.map((clue) => ({
      puzzleId,
      entry: clue.entry,
      lang: clue.lang,
      hint: cluePromptText(clue.customClue) || null,
    })));
  }

  const matchable = pending.filter((clue) => clue.entryExists && clue.senses.length > 0);
  const matchingOk = await matchClues(
    puzzleId,
    matchable,
    provider,
    matchingPrompt,
    concurrency,
    true,
    'Step 1 matching',
  );
  if (!matchingOk) {
    needsRetry = true;
  }

  console.log(`Step 2: generating senses for puzzle ${puzzleId}`);
  const processedEntryKeys = new Set<string>();
  const generation = await drainQueue<SenseGeneratorQueueItem, number>(
    (limit, excludeIds) => getSenseGeneratorQueueForPuzzle(puzzleId, limit, excludeIds),
    (item) => item.queueId,
    1,
    concurrency,
    'Step 2 sense generation',
    (batch, requestLabel) => processSenseGeneratorItem(
      batch[0],
      provider,
      sensesPrompt,
      requestLabel,
      processedEntryKeys,
    ),
  );
  if (!generation.ok) {
    needsRetry = true;
  }

  console.log(`Step 3: rematching ${processedEntryKeys.size} entries processed by sense generation`);
  if (processedEntryKeys.size > 0) {
    const refreshed = await getPuzzleCluesForProcessing(puzzleId);
    const rematch = refreshed.filter(
      (clue) => clue.entryExists
        && !clue.matchAttempted
        && processedEntryKeys.has(entryKey(clue.entry, clue.lang)),
    );
    const rematchOk = await matchClues(
      puzzleId,
      rematch,
      provider,
      matchingPrompt,
      concurrency,
      false,
      'Step 3 matching',
    );
    if (!rematchOk) {
      needsRetry = true;
    }
  }

  console.log(`Step 4: scoring matched senses for puzzle ${puzzleId}`);
  const scoring = await drainQueue<PuzzleSenseScoringItem, string>(
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
  );
  if (!scoring.ok) {
    needsRetry = true;
  }

  console.log(`Step 5: finding references for matched senses without references for puzzle ${puzzleId}`);
  const references = await drainQueue<PuzzleSenseReferenceItem, string>(
    (limit, excludeIds) => getMatchedSensesWithoutReferences(puzzleId, limit, excludeIds),
    (item) => item.senseId,
    REFERENCES_PER_PROMPT,
    concurrency,
    'Step 5 sense references',
    (batch, requestLabel) => processReferenceBatch(batch, provider, referencePrompt, requestLabel),
  );
  console.log(`Finished steps for puzzle ${puzzleId}`);
  return needsRetry || !references.ok;
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

