/*
Keep looping through the following steps until maxItems AI requests have been sent (default 100), then stop:
1. Select enough entries for parallelRequests concurrent executions via get_entries_for_familiarity_generator_top_50
   (each request uses ENTRIES_PER_REQUEST entries). Entries have a reviewed_status of "12", along with all of their secondary classes.
2. Split the selected entries into chunks of ENTRIES_PER_REQUEST and process up to parallelRequests chunks in parallel:
   a. For each chunk, generate a prompt using the familiarity_prompt_3.txt file. Include the unity bucket with each entry in the prompt.
      Also check if there are any secondary classes for that entry. If so, include them in the prompt (each on a new line) using the entry's unity bucket.
      Send the prompt to the AIProvider (make this a parameter).
   b. Update a few fields in the entry table with the results:
      - familiarity_bucket
      - familiarity_score (Beginner Core = 50, Ubiquitous = 45, Active = 40, Easy Collocation = 35, General Knowledge = 30,
        Inferred = 25, Niche = 20, Obscure = 15, Barely Exists = 10, Nonsense = 0).
      - reviewed_status = "123"
   c. If any secondary classes get rated as Obscure, Barely Exists, or Nonsense, delete them from the entry_secondary_class table.
      Among the primary class and secondary classes, replace the entry_type and display_text of the entry row with the one that got
      the highest familiarity score and move any others into the entry_secondary_class table.
3. maxItems is the total number of AI requests to send before quitting (not the number of DB cycles).

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesForFamiliarityGeneratorTop50,
  upsertFamiliarityGeneratorResults,
  EntryForFamiliarityGenerator,
  FamiliarityGeneratorResult,
  FamiliarityGeneratorSecondaryClass,
} from 'cruzi-db';
import { CursorAiProvider } from './ai/cursor';
import { IAiProvider } from './ai/IAiProvider';
import { scorePhrasesForFamiliarityBucket } from './ai/phraseScoring';
import { batchArray, isGeminiTimeoutError } from './lib/utils';

const ENTRIES_PER_REQUEST = 50;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;

const FAMILIARITY_SCORES: Record<string, number> = {
  'Beginner Core': 50,
  Ubiquitous: 45,
  Active: 40,
  'Easy Collocation': 35,
  'General Knowledge': 30,
  Inferred: 25,
  Niche: 20,
  Obscure: 15,
  'Barely Exists': 10,
  Nonsense: 0,
};

const cursorProvider = new CursorAiProvider();

function isDeletableFamiliarityBucket(bucket: string): boolean {
  return bucket === 'Obscure' || bucket === 'Barely Exists' || bucket === 'Nonsense';
}

function collectPromptPhrases(
  entries: EntryForFamiliarityGenerator[],
): Array<{ phrase: string; unityBucket: string }> {
  const phrases: Array<{ phrase: string; unityBucket: string }> = [];
  const seen = new Set<string>();

  for (const entryItem of entries) {
    const unityBucket = entryItem.unityBucket?.trim() || 'Concept';
    const candidates = [
      entryItem.displayText,
      ...entryItem.secondaryClasses.map((secondary) => secondary.secondaryDisplay),
    ];

    for (const phrase of candidates) {
      const trimmed = phrase.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      phrases.push({ phrase: trimmed, unityBucket });
    }
  }

  return phrases;
}

function pickHighestFamiliarityCandidate(
  remainingSecondaries: FamiliarityGeneratorSecondaryClass[],
  resultsByPhrase: Map<string, { bucket: string }>,
  primaryScore: number,
): { kind: 'primary' } | { kind: 'secondary'; secondary: FamiliarityGeneratorSecondaryClass; score: number } {
  const rankedSecondaries = remainingSecondaries
    .map((secondary) => {
      const parsed = resultsByPhrase.get(secondary.secondaryDisplay);
      if (!parsed) {
        return null;
      }
      const score = FAMILIARITY_SCORES[parsed.bucket];
      if (score == null) {
        return null;
      }
      return { secondary, score };
    })
    .filter(
      (item): item is { secondary: FamiliarityGeneratorSecondaryClass; score: number } => item !== null,
    )
    .sort((a, b) => b.score - a.score);

  const bestSecondary = rankedSecondaries[0];
  if (bestSecondary && bestSecondary.score > primaryScore) {
    return { kind: 'secondary', secondary: bestSecondary.secondary, score: bestSecondary.score };
  }

  return { kind: 'primary' };
}

function buildResultsToPersist(
  entries: EntryForFamiliarityGenerator[],
  resultsByPhrase: Map<string, { bucket: string }>,
): FamiliarityGeneratorResult[] {
  const resultsToPersist: FamiliarityGeneratorResult[] = [];

  for (const entryItem of entries) {
    const primaryParsed = resultsByPhrase.get(entryItem.displayText);
    if (!primaryParsed) {
      console.warn(
        `Skipping ${entryItem.entry} (${entryItem.lang}): no familiarity rating for primary "${entryItem.displayText}"`,
      );
      continue;
    }

    const familiarityScore = FAMILIARITY_SCORES[primaryParsed.bucket];
    if (familiarityScore == null) {
      console.warn(
        `Skipping ${entryItem.entry} (${entryItem.lang}): unknown familiarity bucket "${primaryParsed.bucket}"`,
      );
      continue;
    }

    const secondaryClassesToDelete: string[] = [];
    for (const secondary of entryItem.secondaryClasses) {
      const secondaryParsed = resultsByPhrase.get(secondary.secondaryDisplay);
      if (secondaryParsed && isDeletableFamiliarityBucket(secondaryParsed.bucket)) {
        secondaryClassesToDelete.push(secondary.secondaryClass);
        console.log(
          `  deleting secondary ${entryItem.entry}: class=${secondary.secondaryClass}, ` +
            `form=${secondary.secondaryDisplay}, familiarity=${secondaryParsed.bucket}`,
        );
      }
    }

    const remainingSecondaries = entryItem.secondaryClasses.filter(
      (secondary) => !secondaryClassesToDelete.includes(secondary.secondaryClass),
    );
    const winner = pickHighestFamiliarityCandidate(
      remainingSecondaries,
      resultsByPhrase,
      familiarityScore,
    );

    let familiarityBucket = primaryParsed.bucket;
    let persistedScore = familiarityScore;
    let displayText: string | undefined;
    let entryType: string | undefined;
    let baseForm: string | undefined;
    const secondaryClassesToInsert: FamiliarityGeneratorResult['secondaryClassesToInsert'] = [];

    if (winner.kind === 'secondary') {
      const promotedParsed = resultsByPhrase.get(winner.secondary.secondaryDisplay);
      familiarityBucket = promotedParsed?.bucket ?? familiarityBucket;
      persistedScore = FAMILIARITY_SCORES[familiarityBucket] ?? winner.score;
      displayText = winner.secondary.secondaryDisplay;
      entryType = winner.secondary.secondaryClass;
      baseForm = winner.secondary.secondaryBaseForm;
      secondaryClassesToDelete.push(winner.secondary.secondaryClass);

      if (entryItem.entryType && !isDeletableFamiliarityBucket(primaryParsed.bucket)) {
        secondaryClassesToInsert.push({
          secondaryClass: entryItem.entryType,
          secondaryDisplay: entryItem.displayText,
          secondaryBaseForm: entryItem.baseForm,
        });
      }

      console.log(
        `  promoting secondary ${entryItem.entry}: class=${winner.secondary.secondaryClass}, ` +
          `form=${winner.secondary.secondaryDisplay}, familiarity=${familiarityBucket} ` +
          `(primary was ${primaryParsed.bucket})`,
      );
    }

    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      familiarityBucket,
      familiarityScore: persistedScore,
      reviewedStatus: '123',
      displayText,
      entryType,
      baseForm,
      secondaryClassesToDelete,
      secondaryClassesToInsert,
    });

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): familiarity_bucket=${familiarityBucket}, ` +
        `familiarity_score=${persistedScore}, reviewed_status=123, ` +
        `deleted_secondaries=${secondaryClassesToDelete.length}, ` +
        `inserted_secondaries=${secondaryClassesToInsert.length}`,
    );
  }

  return resultsToPersist;
}

async function processBatch(
  entries: EntryForFamiliarityGenerator[],
  provider: IAiProvider,
  requestLabel: string,
): Promise<number> {
  const phrases = collectPromptPhrases(entries);
  console.log(
    `${requestLabel}: sending familiarity prompt for ${entries.length} entries (${phrases.length} phrases)`,
  );

  const resultsByPhrase = await scorePhrasesForFamiliarityBucket(phrases, provider);
  console.log(`${requestLabel}: received ${resultsByPhrase.size} familiarity ratings`);

  const resultsToPersist = buildResultsToPersist(entries, resultsByPhrase);
  if (resultsToPersist.length === 0) {
    console.warn(`${requestLabel}: no valid familiarity generator results to persist`);
    return 0;
  }

  await upsertFamiliarityGeneratorResults(resultsToPersist);
  console.log(`${requestLabel}: updated familiarity results for ${resultsToPersist.length} entries`);
  return resultsToPersist.length;
}

export async function familiarityGenerator(
  provider: IAiProvider = cursorProvider,
  maxItems: number = DEFAULT_MAX_ITEMS,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
): Promise<void> {
  try {
    const concurrency = Math.max(1, parallelRequests);

    console.log(
      `Starting familiarity generation with provider ${provider.sourceAI} ` +
        `(max ${maxItems} AI requests, ${concurrency} parallel)...`,
    );

    let itemsCompleted = 0;
    let cycleNumber = 0;
    let shouldStop = false;

    while (itemsCompleted < maxItems && !shouldStop) {
      const remainingItems = maxItems - itemsCompleted;
      const requestsThisCycle = Math.min(concurrency, remainingItems);
      const selectLimit = requestsThisCycle * ENTRIES_PER_REQUEST;

      const entries = await getEntriesForFamiliarityGeneratorTop50(selectLimit);
      if (entries.length === 0) {
        console.log('No entries remaining with reviewed_status 12');
        break;
      }

      const chunks = batchArray(entries, ENTRIES_PER_REQUEST);
      cycleNumber++;
      console.log(
        `Cycle ${cycleNumber}: ${chunks.length} parallel AI requests ` +
          `(${entries.length} entries); ` +
          `${itemsCompleted}/${maxItems} requests completed so far`,
      );

      const persistedCounts = await Promise.all(
        chunks.map(async (chunk, index) => {
          const itemNumber = itemsCompleted + index + 1;
          const requestLabel = `Request ${itemNumber}/${maxItems}`;

          try {
            return await processBatch(chunk, provider, requestLabel);
          } catch (error) {
            if (isGeminiTimeoutError(error)) {
              console.warn(`AI timeout processing familiarity ${requestLabel}`);
              shouldStop = true;
              return 0;
            }

            console.error(`Error processing familiarity ${requestLabel}:`, error);
            shouldStop = true;
            return 0;
          }
        }),
      );

      itemsCompleted += chunks.length;

      if (!shouldStop && persistedCounts.every((count) => count === 0)) {
        console.warn(`No entries persisted in cycle ${cycleNumber}; stopping`);
        break;
      }
    }

    if (itemsCompleted >= maxItems) {
      console.log(`Reached max AI request limit of ${maxItems}; stopping`);
    } else {
      console.log(`Stopped after ${itemsCompleted} AI requests`);
    }
  } catch (error) {
    console.error('Fatal error in familiarityGenerator:', error);
    throw error;
  }
}
