/*
Keep looping through the following steps until maxBatches AI requests have been sent (default 100), then stop:
1. Select enough entries for parallelRequests AI calls (each call uses ENTRIES_PER_REQUEST entries)
   via get_entries_for_entry_improver.
2. Split the selected entries into chunks of ENTRIES_PER_REQUEST and send that many AI requests in parallel.
3. For each chunk, generate a prompt using the entry_improver_prompt.txt file and send it to the AI provider.
4. Aggregate all parsed results from the parallel requests, then perform a single DB upsert:
    - entry_type
    - display_text
    - base_form
    - unity_bucket
    - unity_score (Concept = 5, Collocation = 4, Formula = 3, Non-unit = 2, Nonsense = 1)
    - familiarity_bucket
    - familiarity_score (Beginner Core = 50, Fundamental = 45, Active = 40, Easy Collocation = 35, 
        Well-Known = 30, Inferred = 25, Niche = 20, Obscure = 15, Barely Exists = 10, Nonsense = 0)
    - quality_bucket
    - quality_score (Warm = 40, Fun = 35, Interesting = 35, Normal = 30, Non-Dominant = 25, 
        Awkward = 20, Clunky = 15, Barely Coherent = 10, Nonsense = 0)
    - is_vulgar
    - reviewed_status = 'R'
5. Skip (do not update) any entry whose AI result has an invalid entry_type, unity/familiarity/quality
   bucket, or vulgarity value.
6. Skip (do not update) any entry whose AI display_text does not normalize back to the original entry
   (all caps, letters and numerals only, accents stripped — same check as entryParser).
7. maxBatches is the total number of AI requests to send before quitting (not the number of DB cycles).

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  getEntriesForEntryImprover,
  upsertEntryImproverResults,
  EntryForEntryImprover,
} from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { IAiProvider } from './ai/IAiProvider';
import { matchParsedResultsByIdentity } from './lib/resultMatching';
import { batchArray, entryToAllCaps } from './lib/utils';

const UNITY_SCORES: Record<string, number> = {
  Concept: 5,
  Collocation: 4,
  Formula: 3,
  'Non-unit': 2,
  Nonsense: 1,
};

const FAMILIARITY_SCORES: Record<string, number> = {
  'Beginner Core': 50,
  Fundamental: 45,
  Active: 40,
  'Easy Collocation': 35,
  'Well-Known': 30,
  Inferred: 25,
  Niche: 20,
  Obscure: 15,
  'Barely Exists': 10,
  Nonsense: 0,
};

const QUALITY_SCORES: Record<string, number> = {
  Warm: 40,
  Fun: 35,
  Interesting: 35,
  Normal: 30,
  'Non-Dominant': 25,
  Awkward: 20,
  Clunky: 15,
  'Barely Coherent': 10,
  Nonsense: 0,
};

const ENTRY_TYPES = new Set([
  'Word',
  'Inflected Word',
  'Phrase',
  'Inflected Phrase',
  'Proper Name',
  'Acronym/Abbreviation',
  'Prefix/Suffix',
  'Nonsense',
]);

const ENTRIES_PER_REQUEST = 10;
const DEFAULT_MAX_BATCHES = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;

interface ParsedEntryImproverResult {
  entry: string;
  entryType: string;
  displayText: string;
  baseForm?: string;
  unityBucket: string;
  familiarityBucket: string;
  qualityBucket: string;
  isVulgar: boolean;
}

async function loadEntryImproverPromptAsync(): Promise<string> {
  try {
    return await fs.promises.readFile('./src/ai/entry_improver_prompt.txt', 'utf-8');
  } catch (err) {
    console.error('Error reading entry improver prompt file:', err);
    throw err;
  }
}

function parseDisplayTextAndBaseForm(raw: string): { displayText: string; baseForm?: string } {
  const baseMatch = raw.match(/^(.+?)\s+\((.+)\)$/);
  if (baseMatch) {
    return {
      displayText: baseMatch[1].trim(),
      baseForm: baseMatch[2].trim(),
    };
  }
  return { displayText: raw.trim() };
}

function parseVulgarity(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'yes' || normalized === 'y' || normalized === 'true') {
    return true;
  }
  if (normalized === 'no' || normalized === 'n' || normalized === 'false') {
    return false;
  }
  return null;
}

export function parseEntryImproverResponse(response: string): ParsedEntryImproverResult[] {
  const lines = response
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const results: ParsedEntryImproverResult[] = [];

  for (const line of lines) {
    const parts = line.split(' : ').map((part) => part.trim());
    if (parts.length < 7) {
      continue;
    }

    const entry = parts[0];
    const entryType = parts[1];
    const unityBucket = parts[3];
    const familiarityBucket = parts[4];
    const qualityBucket = parts[5];
    const isVulgar = parseVulgarity(parts[6]);

    if (!entry || !ENTRY_TYPES.has(entryType)) {
      continue;
    }
    if (!(unityBucket in UNITY_SCORES)) {
      continue;
    }
    if (!(familiarityBucket in FAMILIARITY_SCORES)) {
      continue;
    }
    if (!(qualityBucket in QUALITY_SCORES)) {
      continue;
    }
    if (isVulgar === null) {
      continue;
    }

    const { displayText, baseForm } = parseDisplayTextAndBaseForm(parts[2]);
    if (!displayText) {
      continue;
    }

    results.push({
      entry,
      entryType,
      displayText,
      baseForm,
      unityBucket,
      familiarityBucket,
      qualityBucket,
      isVulgar,
    });
  }

  return results;
}

function isDisplayTextValidForEntry(entryKey: string, displayText: string): boolean {
  // Accents in display_text are fine (jalapeño ↔ JALAPENO); numerals are preserved.
  return entryToAllCaps(displayText) === entryKey;
}

function matchParsedResultsToEntries(
  entries: EntryForEntryImprover[],
  parsedResults: ParsedEntryImproverResult[],
): Array<{ entry: EntryForEntryImprover; parsed: ParsedEntryImproverResult } | null> {
  return matchParsedResultsByIdentity(
    entries,
    parsedResults,
    (entryItem) => [entryItem.entry],
    (parsed) => [parsed.entry, parsed.displayText],
  ).map((match) => (match ? { entry: match.input, parsed: match.parsed } : null));
}

function buildEntriesToPersist(
  entries: EntryForEntryImprover[],
  parsedResults: ParsedEntryImproverResult[],
): Entry[] {
  const matches = matchParsedResultsToEntries(entries, parsedResults);
  const resultsToPersist: Entry[] = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const entryItem = entries[i];

    if (!match) {
      console.warn(`Skipping ${entryItem.entry} (${entryItem.lang}): no valid AI result`);
      continue;
    }

    const { parsed } = match;
    const displayText = parsed.displayText;

    if (!isDisplayTextValidForEntry(entryItem.entry, displayText)) {
      console.warn(
        `Skipping ${entryItem.entry} (${entryItem.lang}): ` +
          `display_text "${displayText}" does not match entry`,
      );
      continue;
    }

    const unityScore = UNITY_SCORES[parsed.unityBucket];
    const familiarityScore = FAMILIARITY_SCORES[parsed.familiarityBucket];
    const qualityScore = QUALITY_SCORES[parsed.qualityBucket];

    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      entryType: parsed.entryType,
      displayText,
      baseForm: parsed.baseForm,
      unityBucket: parsed.unityBucket,
      unityScore,
      familiarityBucket: parsed.familiarityBucket,
      familiarityScore,
      qualityBucket: parsed.qualityBucket,
      qualityScore,
      isVulgar: parsed.isVulgar,
      reviewedStatus: 'R',
    });

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): ` +
        `type=${parsed.entryType}, display="${displayText}"` +
        `${parsed.baseForm ? `, base=${parsed.baseForm}` : ''}, ` +
        `unity=${parsed.unityBucket}/${unityScore}, ` +
        `familiarity=${parsed.familiarityBucket}/${familiarityScore}, ` +
        `quality=${parsed.qualityBucket}/${qualityScore}, ` +
        `vulgar=${parsed.isVulgar}`,
    );
  }

  return resultsToPersist;
}

async function processAiRequest(
  entries: EntryForEntryImprover[],
  promptTemplate: string,
  provider: IAiProvider,
  requestLabel: string,
): Promise<Entry[]> {
  const promptData = entries.map((entryItem) => entryItem.entry).join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`${requestLabel}: sending prompt for ${entries.length} entries`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: received response (${aiResponse.length} characters)`);

  const parsedResults = parseEntryImproverResponse(aiResponse);
  console.log(`${requestLabel}: parsed ${parsedResults.length} results`);

  if (parsedResults.length === 0) {
    console.warn(`${requestLabel}: no results parsed; skipping`);
    return [];
  }

  if (parsedResults.length !== entries.length) {
    console.warn(
      `${requestLabel}: expected ${entries.length} results but parsed ${parsedResults.length}`,
    );
  }

  return buildEntriesToPersist(entries, parsedResults);
}

export async function entryImprover(
  provider: IAiProvider,
  maxBatches: number = DEFAULT_MAX_BATCHES,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
): Promise<void> {
  try {
    const concurrency = Math.max(1, parallelRequests);

    console.log(
      `Starting entry improver with provider ${provider.sourceAI} ` +
        `(max ${maxBatches} AI requests, ${concurrency} parallel)...`,
    );

    const promptTemplate = await loadEntryImproverPromptAsync();

    let requestsCompleted = 0;
    let cycleNumber = 0;

    while (requestsCompleted < maxBatches) {
      const remainingRequests = maxBatches - requestsCompleted;
      const requestsThisCycle = Math.min(concurrency, remainingRequests);
      const selectLimit = requestsThisCycle * ENTRIES_PER_REQUEST;

      const entries = await getEntriesForEntryImprover(selectLimit);
      if (entries.length === 0) {
        console.log('No entries remaining without reviewed_status');
        break;
      }

      const chunks = batchArray(entries, ENTRIES_PER_REQUEST);
      cycleNumber++;
      console.log(
        `Cycle ${cycleNumber}: ${chunks.length} parallel AI requests ` +
          `(${entries.length} entries); ` +
          `${requestsCompleted}/${maxBatches} requests completed so far`,
      );

      try {
        const chunkResults = await Promise.all(
          chunks.map((chunk, index) =>
            processAiRequest(
              chunk,
              promptTemplate,
              provider,
              `Request ${requestsCompleted + index + 1}/${maxBatches}`,
            ).catch((error) => {
              console.error(
                `Error in AI request ${requestsCompleted + index + 1}:`,
                error,
              );
              return [] as Entry[];
            }),
          ),
        );

        const resultsToPersist = chunkResults.flat();
        if (resultsToPersist.length > 0) {
          await upsertEntryImproverResults(resultsToPersist);
          console.log(
            `Cycle ${cycleNumber}: updated entry improver fields for ${resultsToPersist.length} entries`,
          );
        } else {
          console.warn(`Cycle ${cycleNumber}: no valid results to persist`);
        }

        requestsCompleted += chunks.length;
      } catch (error) {
        console.error(`Error processing entry improver cycle ${cycleNumber}:`, error);
        break;
      }
    }

    if (requestsCompleted >= maxBatches) {
      console.log(`Reached max AI request limit of ${maxBatches}; stopping`);
    } else {
      console.log(`Stopped after ${requestsCompleted} AI requests`);
    }
  } catch (error) {
    console.error('Fatal error in entryImprover:', error);
    throw error;
  }
}
