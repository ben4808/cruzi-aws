/*
Keep looping through the following steps until maxItems AI requests have been sent (default 100), then stop:
1. Select enough entries for parallelRequests concurrent executions via get_entries_for_familiarity_generator_top_50
   (each request uses ENTRIES_PER_REQUEST entries). Entries have a reviewed_status of "12", along with all of their secondary classes.
   Skip entries whose unity_bucket or entry_type is Nonsense.
2. Split the selected entries into chunks of ENTRIES_PER_REQUEST and process up to parallelRequests chunks in parallel:
   a. For each chunk, generate a prompt using the familiarity_prompt_3.txt file. Include the classification (entry_type)
      and the unity bucket with each entry in the prompt.
      Also check if there are any secondary classes for that entry. If so, include them in the prompt (each on a new line),
      using that secondary's own classification and unity bucket rather than the main entry's.
      Send the prompt to the AIProvider (make this a parameter).
    b. Update a few fields in the entry table with the results:
      - familiarity_bucket
      - familiarity_score (Beginner Core = 50, Ubiquitous = 45, Active = 40, Easy Collocation = 35,
        Common Name = 30, General Knowledge = 30, Colloquial = 30, Inferred = 25, Niche = 20, Variant = 20,
        Partial Phrase = 20, Obscure = 15, Barely Exists = 10, Nonsense = 0).
        Partial Phrase is not an AI bucket. After AI results, collect items rated Obscure and run one
        bulk get_partial_phrase_items query per AI batch for phrases that start or end with those
        items (space-separated, e.g. "Velva" matches "Aqua Velva" but not "AqueVelva"). If any such
        phrase has familiarity_score >= 20, overwrite the item's familiarity bucket to Partial Phrase
        and the score to 20.
      - reviewed_status = "123"
   c. If any secondary classes get rated as Obscure, Barely Exists, or Nonsense, delete them from the entry_secondary_class table.
      For secondaries that are rated and kept, set their familiarity_bucket on the entry_secondary_class row.
      Among the primary class and secondary classes, replace the entry_type and display_text of the entry row with the one that got
      the highest familiarity score and move any others into the entry_secondary_class table.
3. maxItems is the total number of AI requests to send before quitting (not the number of entries
   processed, and not the number of DB cycles).
   Keep querying new batches as long as get_entries_for_familiarity_generator_top_50 returns eligible items,
   until maxItems AI requests have been sent. A cycle that persists nothing must not stop the loop
   while eligible items remain.
   If an AI request takes more than 5 minutes, abandon it and continue with the remaining work.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesForFamiliarityGeneratorTop50,
  getPartialPhraseItems,
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
  'Common Name': 30,
  'General Knowledge': 30,
  Colloquial: 30,
  Inferred: 25,
  Niche: 20,
  Variant: 20,
  'Partial Phrase': 20,
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
): Array<{ phrase: string; entryType: string; unityBucket: string }> {
  const phrases: Array<{ phrase: string; entryType: string; unityBucket: string }> = [];
  const seen = new Set<string>();

  for (const entryItem of entries) {
    const candidates = [
      {
        phrase: entryItem.displayText,
        entryType: entryItem.entryType,
        unityBucket: entryItem.unityBucket,
      },
      ...entryItem.secondaryClasses.map((secondary) => ({
        phrase: secondary.secondaryDisplay,
        entryType: secondary.secondaryClass,
        unityBucket: secondary.unityBucket,
      })),
    ];

    for (const candidate of candidates) {
      const trimmed = candidate.phrase.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      phrases.push({
        phrase: trimmed,
        entryType: candidate.entryType?.trim() || 'Word',
        unityBucket: candidate.unityBucket?.trim() || 'Nonsense',
      });
    }
  }

  return phrases;
}

async function applyPartialPhraseInference(
  entries: EntryForFamiliarityGenerator[],
  resultsByPhrase: Map<string, { bucket: string }>,
): Promise<void> {
  const obscureItems: Array<{ displayText: string; lang: string }> = [];
  const seen = new Set<string>();

  const consider = (phrase: string, lang: string) => {
    const trimmed = phrase.trim();
    if (!trimmed) {
      return;
    }

    const parsed = resultsByPhrase.get(trimmed) ?? resultsByPhrase.get(phrase);
    if (parsed?.bucket !== 'Obscure') {
      return;
    }

    const key = `${lang}\0${trimmed}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    obscureItems.push({ displayText: trimmed, lang });
  };

  for (const entryItem of entries) {
    consider(entryItem.displayText, entryItem.lang);
    for (const secondary of entryItem.secondaryClasses) {
      consider(secondary.secondaryDisplay, entryItem.lang);
    }
  }

  if (obscureItems.length === 0) {
    return;
  }

  // One bulk lookup for the whole AI batch, not one query per obscure item.
  const matches = await getPartialPhraseItems(obscureItems);
  for (const match of matches) {
    const parsed = resultsByPhrase.get(match.displayText);
    if (!parsed) {
      continue;
    }

    parsed.bucket = 'Partial Phrase';
    console.log(
      `  inferred Partial Phrase for "${match.displayText}" (${match.lang})`,
    );
  }
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
    const secondaryClassesToUpdate: NonNullable<FamiliarityGeneratorResult['secondaryClassesToUpdate']> = [];
    for (const secondary of entryItem.secondaryClasses) {
      const secondaryParsed = resultsByPhrase.get(secondary.secondaryDisplay);
      if (!secondaryParsed) {
        continue;
      }
      if (isDeletableFamiliarityBucket(secondaryParsed.bucket)) {
        secondaryClassesToDelete.push(secondary.secondaryClass);
        console.log(
          `  deleting secondary ${entryItem.entry}: class=${secondary.secondaryClass}, ` +
            `form=${secondary.secondaryDisplay}, familiarity=${secondaryParsed.bucket}`,
        );
        continue;
      }
      secondaryClassesToUpdate.push({
        secondaryClass: secondary.secondaryClass,
        familiarityBucket: secondaryParsed.bucket,
      });
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
      const promotedIndex = secondaryClassesToUpdate.findIndex(
        (item) => item.secondaryClass === winner.secondary.secondaryClass,
      );
      if (promotedIndex >= 0) {
        secondaryClassesToUpdate.splice(promotedIndex, 1);
      }

      if (entryItem.entryType && !isDeletableFamiliarityBucket(primaryParsed.bucket)) {
        secondaryClassesToInsert.push({
          secondaryClass: entryItem.entryType,
          secondaryDisplay: entryItem.displayText,
          secondaryBaseForm: entryItem.baseForm,
          familiarityBucket: primaryParsed.bucket,
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
      secondaryClassesToUpdate,
      secondaryClassesToInsert,
    });

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): familiarity_bucket=${familiarityBucket}, ` +
        `familiarity_score=${persistedScore}, reviewed_status=123, ` +
        `deleted_secondaries=${secondaryClassesToDelete.length}, ` +
        `updated_secondaries=${secondaryClassesToUpdate.length}, ` +
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

  await applyPartialPhraseInference(entries, resultsByPhrase);

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

    let requestsCompleted = 0;
    let cycleNumber = 0;
    let shouldStop = false;

    while (requestsCompleted < maxItems && !shouldStop) {
      const remainingRequests = maxItems - requestsCompleted;
      const requestsThisCycle = Math.min(concurrency, remainingRequests);
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
          `${requestsCompleted}/${maxItems} requests completed so far`,
      );

      const persistedCounts = await Promise.all(
        chunks.map(async (chunk, index) => {
          const requestNumber = requestsCompleted + index + 1;
          const requestLabel = `Request ${requestNumber}/${maxItems}`;

          try {
            return await processBatch(chunk, provider, requestLabel);
          } catch (error) {
            if (isGeminiTimeoutError(error)) {
              console.warn(
                `${requestLabel}: AI request took more than 5 minutes; abandoning and continuing`,
              );
              return 0;
            }

            console.error(`Error processing familiarity ${requestLabel}:`, error);
            shouldStop = true;
            return 0;
          }
        }),
      );

      requestsCompleted += chunks.length;

      if (persistedCounts.every((count) => count === 0)) {
        console.warn(
          `No entries persisted in cycle ${cycleNumber}; continuing while eligible items remain`,
        );
      }
    }

    if (requestsCompleted >= maxItems) {
      console.log(`Reached max AI request limit of ${maxItems}; stopping`);
    } else {
      console.log(`Stopped after ${requestsCompleted} AI requests`);
    }
  } catch (error) {
    console.error('Fatal error in familiarityGenerator:', error);
    throw error;
  }
}
