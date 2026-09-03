/*
Keep looping through the following steps until maxItems AI requests have been sent (default 100), then stop:
1. Select enough entries for parallelRequests concurrent executions via get_entries_for_quality_generator_top_50
   (each request uses ENTRIES_PER_REQUEST entries). Entries have a reviewed_status of "123" and
   neither unity_bucket nor entry_type is Nonsense, along with their unity and familiarity buckets,
   regardless of existing quality_bucket. Optionally further restrict by an entry LIKE pattern (e.g. "VE___").
2. Split the selected entries into chunks of ENTRIES_PER_REQUEST and process up to parallelRequests chunks in parallel:
   a. For each chunk, generate a prompt using the quality_prompt_3.txt file. Include the unity bucket and
      familiarity bucket with each entry in the prompt.
      Send the prompt to the AIProvider (make this a parameter).
   b. Update a few fields in the entry table with the results:
      - quality_bucket
      - quality_score (Pass 1 buckets = 20, Pass 2 buckets = 40, Normal = 30).
        Pass 1: Non-unit, Unfamiliar, Uncommon Inflection, Partial, Clunky.
        Pass 2: Idiomatic, Interesting, Appealing, Emotional, Trendy.
      - reviewed_status = "1234"
3. maxItems is the total number of AI requests to send before quitting (not the number of DB cycles).
   If an AI request takes more than 5 minutes, abandon it and continue with the remaining work.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesForQualityGeneratorTop50,
  upsertQualityGeneratorResults,
  EntryForQualityGenerator,
  QualityGeneratorResult,
} from 'cruzi-db';
import { CursorAiProvider } from './ai/cursor';
import { IAiProvider } from './ai/IAiProvider';
import { scorePhrasesForQualityBucket } from './ai/phraseScoring';
import { batchArray, isGeminiTimeoutError } from './lib/utils';

const ENTRIES_PER_REQUEST = 50;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;

const QUALITY_SCORES: Record<string, number> = {
  'Non-unit': 20,
  Unfamiliar: 20,
  'Uncommon Inflection': 20,
  Partial: 20,
  Clunky: 20,
  Idiomatic: 40,
  Interesting: 40,
  Appealing: 40,
  Emotional: 40,
  Trendy: 40,
  Normal: 30,
};

const cursorProvider = new CursorAiProvider();

function collectPromptPhrases(
  entries: EntryForQualityGenerator[],
): Array<{ phrase: string; unityBucket: string; familiarityBucket: string }> {
  const phrases: Array<{ phrase: string; unityBucket: string; familiarityBucket: string }> = [];
  const seen = new Set<string>();

  for (const entryItem of entries) {
    const trimmed = entryItem.displayText.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    phrases.push({
      phrase: trimmed,
      unityBucket: entryItem.unityBucket.trim(),
      familiarityBucket: entryItem.familiarityBucket.trim(),
    });
  }

  return phrases;
}

function buildResultsToPersist(
  entries: EntryForQualityGenerator[],
  resultsByPhrase: Map<string, { bucket: string }>,
): QualityGeneratorResult[] {
  const resultsToPersist: QualityGeneratorResult[] = [];

  for (const entryItem of entries) {
    const parsed = resultsByPhrase.get(entryItem.displayText.trim());
    if (!parsed) {
      console.warn(
        `Skipping ${entryItem.entry} (${entryItem.lang}): no quality rating for "${entryItem.displayText}"`,
      );
      continue;
    }

    const qualityScore = QUALITY_SCORES[parsed.bucket];
    if (qualityScore == null) {
      console.warn(
        `Skipping ${entryItem.entry} (${entryItem.lang}): unknown quality bucket "${parsed.bucket}"`,
      );
      continue;
    }

    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      qualityBucket: parsed.bucket,
      qualityScore,
      reviewedStatus: '1234',
    });

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): quality_bucket=${parsed.bucket}, ` +
        `quality_score=${qualityScore}, reviewed_status=1234`,
    );
  }

  return resultsToPersist;
}

async function processBatch(
  entries: EntryForQualityGenerator[],
  provider: IAiProvider,
  requestLabel: string,
): Promise<number> {
  const phrases = collectPromptPhrases(entries);
  console.log(
    `${requestLabel}: sending quality prompt for ${entries.length} entries (${phrases.length} phrases)`,
  );

  const resultsByPhrase = await scorePhrasesForQualityBucket(phrases, provider);
  console.log(`${requestLabel}: received ${resultsByPhrase.size} quality ratings`);

  const resultsToPersist = buildResultsToPersist(entries, resultsByPhrase);
  if (resultsToPersist.length === 0) {
    console.warn(`${requestLabel}: no valid quality generator results to persist`);
    return 0;
  }

  await upsertQualityGeneratorResults(resultsToPersist);
  console.log(`${requestLabel}: updated quality results for ${resultsToPersist.length} entries`);
  return resultsToPersist.length;
}

export async function qualityGenerator(
  provider: IAiProvider = cursorProvider,
  maxItems: number = DEFAULT_MAX_ITEMS,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
  pattern?: string,
): Promise<void> {
  try {
    const concurrency = Math.max(1, parallelRequests);
    const entryPattern = pattern?.trim() || undefined;

    console.log(
      `Starting quality generation with provider ${provider.sourceAI} ` +
        `(max ${maxItems} AI requests, ${concurrency} parallel` +
        `${entryPattern ? `, pattern ${entryPattern}` : ''})...`,
    );

    let itemsCompleted = 0;
    let cycleNumber = 0;
    let shouldStop = false;

    while (itemsCompleted < maxItems && !shouldStop) {
      const remainingItems = maxItems - itemsCompleted;
      const requestsThisCycle = Math.min(concurrency, remainingItems);
      const selectLimit = requestsThisCycle * ENTRIES_PER_REQUEST;

      const entries = await getEntriesForQualityGeneratorTop50(selectLimit, entryPattern);
      if (entries.length === 0) {
        console.log(
          `No entries remaining with reviewed_status 123` +
            `${entryPattern ? ` (pattern ${entryPattern})` : ''}`,
        );
        break;
      }

      const chunks = batchArray(entries, ENTRIES_PER_REQUEST);
      cycleNumber++;
      console.log(
        `Cycle ${cycleNumber}: ${chunks.length} parallel AI requests ` +
          `(${entries.length} entries); ` +
          `${itemsCompleted}/${maxItems} requests completed so far`,
      );

      let cycleHadTimeout = false;
      const persistedCounts = await Promise.all(
        chunks.map(async (chunk, index) => {
          const itemNumber = itemsCompleted + index + 1;
          const requestLabel = `Request ${itemNumber}/${maxItems}`;

          try {
            return await processBatch(chunk, provider, requestLabel);
          } catch (error) {
            if (isGeminiTimeoutError(error)) {
              cycleHadTimeout = true;
              console.warn(
                `${requestLabel}: AI request took more than 5 minutes; abandoning and continuing`,
              );
              return 0;
            }

            console.error(`Error processing quality ${requestLabel}:`, error);
            shouldStop = true;
            return 0;
          }
        }),
      );

      itemsCompleted += chunks.length;

      if (!shouldStop && !cycleHadTimeout && persistedCounts.every((count) => count === 0)) {
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
    console.error('Fatal error in qualityGenerator:', error);
    throw error;
  }
}
