/*
Keep looping through the following steps until maxItems AI requests have been sent (default 100), then stop:
1. Select enough entries for parallelRequests concurrent executions via get_entries_for_unity_generator_top_50
   (each request uses ENTRIES_PER_REQUEST entries). Entries have a reviewed_status of "1", along with all of their secondary classes.
2. Split the selected entries into chunks of ENTRIES_PER_REQUEST and process up to parallelRequests chunks in parallel:
   a. For each chunk, generate a prompt using the unity_prompt_3.txt file. Use the display_text field as the input.
      Also check if there are any secondary classes for that entry. If so, include them in the prompt (each on a new line).
      Send the prompt to the AIProvider (make this a parameter).
   b. Update the unity_bucket and unity_score fields in the entry table with the results.
      The unity_score is a direct mapping of the unity_bucket to a number:
      Concept = 5, Collocation = 4, Formula = 3, Partial = 2, Variant = 2, Non-unit = 2, Nonsense = 1.
      If the (final) unity_bucket is Nonsense, also set familiarity_bucket, familiarity_score,
      quality_bucket, and quality_score to null.
   c. If any secondary classes get rated as Non-unit or Nonsense, delete them from the entry_secondary_class table.
      Do not delete secondary classes rated as Partial or Variant. For secondaries that are rated and kept, set their
      unity_bucket on the entry_secondary_class row.
      If the primary class gets rated as Partial, Variant, Non-unit, or Nonsense, and a secondary class is rated as Concept, Collocation, or Formula,
      set the the entry row's entry_type and display_text to the secondary class's entry_type and display_text and then delete the row
      from the entry_secondary_class table.
   d. Set reviewed_status to "12" for the entry row.
3. maxItems is the total number of AI requests to send before quitting (not the number of DB cycles).
   Keep querying new batches as long as get_entries_for_unity_generator_top_50 returns eligible items,
   until maxItems AI requests have been sent. A cycle that persists nothing must not stop the loop
   while eligible items remain.
   If an AI request takes more than 5 minutes, abandon it and continue with the remaining work.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesForUnityGeneratorTop50,
  upsertUnityGeneratorResults,
  EntryForUnityGenerator,
  UnityGeneratorResult,
  UnityGeneratorSecondaryClass,
} from 'cruzi-db';
import { CursorAiProvider } from './ai/cursor';
import { IAiProvider } from './ai/IAiProvider';
import { scorePhrasesForUnityBucket } from './ai/phraseScoring';
import { batchArray, isGeminiTimeoutError } from './lib/utils';

const ENTRIES_PER_REQUEST = 50;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;

const UNITY_SCORES: Record<string, number> = {
  Concept: 5,
  Collocation: 4,
  Formula: 3,
  Partial: 2,
  Variant: 2,
  'Non-unit': 2,
  Nonsense: 1,
};

const cursorProvider = new CursorAiProvider();

function isGoodUnityBucket(bucket: string): boolean {
  return bucket === 'Concept' || bucket === 'Collocation' || bucket === 'Formula';
}

function isBadUnityBucket(bucket: string): boolean {
  return bucket === 'Partial' || bucket === 'Variant' || bucket === 'Non-unit' || bucket === 'Nonsense';
}

function isDeletableUnityBucket(bucket: string): boolean {
  return bucket === 'Non-unit' || bucket === 'Nonsense';
}

function collectPromptPhrases(entries: EntryForUnityGenerator[]): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();

  for (const entryItem of entries) {
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
      phrases.push(trimmed);
    }
  }

  return phrases;
}

function pickPromotableSecondary(
  secondaries: UnityGeneratorSecondaryClass[],
  resultsByPhrase: Map<string, { bucket: string }>,
): UnityGeneratorSecondaryClass | null {
  const ranked = secondaries
    .map((secondary) => {
      const parsed = resultsByPhrase.get(secondary.secondaryDisplay);
      if (!parsed || !isGoodUnityBucket(parsed.bucket)) {
        return null;
      }
      return { secondary, score: UNITY_SCORES[parsed.bucket] ?? 0 };
    })
    .filter((item): item is { secondary: UnityGeneratorSecondaryClass; score: number } => item !== null)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.secondary ?? null;
}

function buildResultsToPersist(
  entries: EntryForUnityGenerator[],
  resultsByPhrase: Map<string, { bucket: string }>,
): UnityGeneratorResult[] {
  const resultsToPersist: UnityGeneratorResult[] = [];

  for (const entryItem of entries) {
    const primaryParsed = resultsByPhrase.get(entryItem.displayText);
    if (!primaryParsed) {
      console.warn(
        `Skipping ${entryItem.entry} (${entryItem.lang}): no unity rating for primary "${entryItem.displayText}"`,
      );
      continue;
    }

    const secondaryClassesToDelete: string[] = [];
    const secondaryClassesToUpdate: NonNullable<UnityGeneratorResult['secondaryClassesToUpdate']> = [];
    for (const secondary of entryItem.secondaryClasses) {
      const secondaryParsed = resultsByPhrase.get(secondary.secondaryDisplay);
      if (!secondaryParsed) {
        continue;
      }
      if (isDeletableUnityBucket(secondaryParsed.bucket)) {
        secondaryClassesToDelete.push(secondary.secondaryClass);
        console.log(
          `  deleting secondary ${entryItem.entry}: class=${secondary.secondaryClass}, ` +
            `form=${secondary.secondaryDisplay}, unity=${secondaryParsed.bucket}`,
        );
        continue;
      }
      secondaryClassesToUpdate.push({
        secondaryClass: secondary.secondaryClass,
        unityBucket: secondaryParsed.bucket,
      });
    }

    let unityBucket = primaryParsed.bucket;
    let displayText: string | undefined;
    let entryType: string | undefined;

    if (isBadUnityBucket(primaryParsed.bucket)) {
      const remainingSecondaries = entryItem.secondaryClasses.filter(
        (secondary) => !secondaryClassesToDelete.includes(secondary.secondaryClass),
      );
      const promoted = pickPromotableSecondary(remainingSecondaries, resultsByPhrase);
      if (promoted) {
        const promotedParsed = resultsByPhrase.get(promoted.secondaryDisplay);
        unityBucket = promotedParsed?.bucket ?? unityBucket;
        displayText = promoted.secondaryDisplay;
        entryType = promoted.secondaryClass;
        secondaryClassesToDelete.push(promoted.secondaryClass);
        const promotedIndex = secondaryClassesToUpdate.findIndex(
          (item) => item.secondaryClass === promoted.secondaryClass,
        );
        if (promotedIndex >= 0) {
          secondaryClassesToUpdate.splice(promotedIndex, 1);
        }
        console.log(
          `  promoting secondary ${entryItem.entry}: class=${promoted.secondaryClass}, ` +
            `form=${promoted.secondaryDisplay}, unity=${unityBucket} ` +
            `(primary was ${primaryParsed.bucket})`,
        );
      }
    }

    const unityScore = UNITY_SCORES[unityBucket];
    if (unityScore == null) {
      console.warn(
        `Skipping ${entryItem.entry} (${entryItem.lang}): unknown unity bucket "${unityBucket}"`,
      );
      continue;
    }

    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      unityBucket,
      unityScore,
      reviewedStatus: '12',
      displayText,
      entryType,
      secondaryClassesToDelete,
      secondaryClassesToUpdate,
    });

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): unity_bucket=${unityBucket}, ` +
        `unity_score=${unityScore}, reviewed_status=12, ` +
        `${unityBucket === 'Nonsense' ? 'cleared familiarity/quality, ' : ''}` +
        `deleted_secondaries=${secondaryClassesToDelete.length}, ` +
        `updated_secondaries=${secondaryClassesToUpdate.length}`,
    );
  }

  return resultsToPersist;
}

async function processBatch(
  entries: EntryForUnityGenerator[],
  provider: IAiProvider,
  requestLabel: string,
): Promise<number> {
  const phrases = collectPromptPhrases(entries);
  console.log(
    `${requestLabel}: sending unity prompt for ${entries.length} entries (${phrases.length} phrases)`,
  );

  const resultsByPhrase = await scorePhrasesForUnityBucket(phrases, provider, { promptVersion: 3 });
  console.log(`${requestLabel}: received ${resultsByPhrase.size} unity ratings`);

  const resultsToPersist = buildResultsToPersist(entries, resultsByPhrase);
  if (resultsToPersist.length === 0) {
    console.warn(`${requestLabel}: no valid unity generator results to persist`);
    return 0;
  }

  await upsertUnityGeneratorResults(resultsToPersist);
  console.log(`${requestLabel}: updated unity results for ${resultsToPersist.length} entries`);
  return resultsToPersist.length;
}

export async function unityGenerator(
  provider: IAiProvider = cursorProvider,
  maxItems: number = DEFAULT_MAX_ITEMS,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
): Promise<void> {
  try {
    const concurrency = Math.max(1, parallelRequests);

    console.log(
      `Starting unity bucket generation with provider ${provider.sourceAI} ` +
        `(max ${maxItems} AI requests, ${concurrency} parallel)...`,
    );

    let itemsCompleted = 0;
    let cycleNumber = 0;
    let shouldStop = false;

    while (itemsCompleted < maxItems && !shouldStop) {
      const remainingItems = maxItems - itemsCompleted;
      const requestsThisCycle = Math.min(concurrency, remainingItems);
      const selectLimit = requestsThisCycle * ENTRIES_PER_REQUEST;

      const entries = await getEntriesForUnityGeneratorTop50(selectLimit);
      if (entries.length === 0) {
        console.log('No entries remaining with reviewed_status 1');
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
              console.warn(
                `${requestLabel}: AI request took more than 5 minutes; abandoning and continuing`,
              );
              return 0;
            }

            console.error(`Error processing unity ${requestLabel}:`, error);
            shouldStop = true;
            return 0;
          }
        }),
      );

      itemsCompleted += chunks.length;

      if (persistedCounts.every((count) => count === 0)) {
        console.warn(
          `No entries persisted in cycle ${cycleNumber}; continuing while eligible items remain`,
        );
      }
    }

    if (itemsCompleted >= maxItems) {
      console.log(`Reached max AI request limit of ${maxItems}; stopping`);
    } else {
      console.log(`Stopped after ${itemsCompleted} AI requests`);
    }
  } catch (error) {
    console.error('Fatal error in unityGenerator:', error);
    throw error;
  }
}
