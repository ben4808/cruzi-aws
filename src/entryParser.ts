/*
Keep looping through the following steps until maxItems AI requests have been sent (default 100), then stop:
1. Select enough entries for parallelRequests concurrent executions via get_entries_for_entry_parser
   (each request uses ENTRIES_PER_REQUEST entries). Select entries whose reviewed_status does not start
   with "1". Optionally further restrict by an entry LIKE pattern (e.g. "VE___").
2. Split the selected entries into chunks of ENTRIES_PER_REQUEST and process up to parallelRequests chunks in parallel:
   a. For each chunk, generate a prompt using the entry_parser_prompt_3.txt file. Use the entry field as the input.
      Send the prompt to the AIProvider (make this a parameter).
   b. Update the display_text, entry_type, base_form (from "display (base)" inflections; not separate Inflected Word/Phrase types),
      and is_vulgar fields in the entry table with the results.
      Also set reviewed_status to "1".
      Overwrite the existing values for the fields.
      If the primary class is Nonsense, set display_text, familiarity_bucket, familiarity_score,
        unity_bucket, unity_score, quality_bucket, and quality_score to NULL.
      For secondary classes, update the entry_secondary_class table with the results
        only if the secondary_display is different from the primary display text.
        (secondary_class, secondary_display, and secondary_base_form optionally if there is a base form).
      Before sending the update, perform one final check: convert the display_text for each class to all caps, strip accents,
        and remove all spaces and punctuation (preserving numerals). Reversing the substitutions for &, @, and . is optional
        per character (e.g. will.i.am matches both WILLIAM and WILLDOTIDOTAM).
        If none of the resulting keys equal the original input entry, set the display_text for that class to simply the original
        input entry lowercased and set the reviewed_status to "Failed parse" instead of "1".
3. maxItems is the total number of AI requests to send before quitting (not the number of DB cycles).
   If an AI request takes more than 5 minutes, abandon it and continue with the remaining work.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  getEntriesForEntryParser,
  upsertEntryParserResults,
  EntryForEntryParser,
  EntryParserResult,
  EntryParserSecondaryClass,
} from 'cruzi-db';
import { CursorAiProvider } from './ai/cursor';
import {
  ParsedEntryParser3Result,
  parseEntryParser3Response,
} from './ai/entryParserFormat';
import { IAiProvider } from './ai/IAiProvider';
import { matchParsedResultsByIdentity } from './lib/resultMatching';
import { batchArray, entryToAllCaps, isGeminiTimeoutError, stripAccents } from './lib/utils';

const ENTRIES_PER_REQUEST = 50;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_PARALLEL_REQUESTS = 1;

export { parseEntryParser3Response };

const cursorProvider = new CursorAiProvider();

async function loadEntryParserPrompt3Async(): Promise<string> {
  try {
    return await fs.promises.readFile('./src/ai/entry_parser_prompt_3.txt', 'utf-8');
  } catch (err) {
    console.error('Error reading entry parser prompt 3 file:', err);
    throw err;
  }
}

const SUBSTITUTION_REVERSALS: Record<string, string> = {
  '&': 'AND',
  '@': 'AT',
  '.': 'DOT',
};

function collectNormalizedEntryKeys(text: string, index: number, prefix: string, out: Set<string>): void {
  if (index >= text.length) {
    out.add(prefix);
    return;
  }

  const ch = text[index];
  const reversal = SUBSTITUTION_REVERSALS[ch];
  if (reversal) {
    collectNormalizedEntryKeys(text, index + 1, prefix, out);
    collectNormalizedEntryKeys(text, index + 1, prefix + reversal, out);
    return;
  }

  if (/[A-Z0-9]/.test(ch)) {
    collectNormalizedEntryKeys(text, index + 1, prefix + ch, out);
    return;
  }

  collectNormalizedEntryKeys(text, index + 1, prefix, out);
}

function displayTextMatchesEntry(entryKey: string, displayText: string): boolean {
  const keys = new Set<string>();
  collectNormalizedEntryKeys(stripAccents(displayText).toUpperCase(), 0, '', keys);
  return keys.has(entryKey);
}

function resolveDisplayText(entryKey: string, parsedDisplayText: string): string {
  if (!displayTextMatchesEntry(entryKey, parsedDisplayText)) {
    return entryKey.toLowerCase();
  }
  return parsedDisplayText;
}

function matchParsedResultsToEntries(
  entries: EntryForEntryParser[],
  parsedResults: ParsedEntryParser3Result[],
): Array<{ entry: EntryForEntryParser; parsed: ParsedEntryParser3Result } | null> {
  return matchParsedResultsByIdentity(
    entries,
    parsedResults,
    (entryItem) => [entryItem.entry],
    (parsed) => [parsed.entry, parsed.primary.displayText],
  ).map((match) => (match ? { entry: match.input, parsed: match.parsed } : null));
}

function buildResultsToPersist(
  entries: EntryForEntryParser[],
  parsedResults: ParsedEntryParser3Result[],
): EntryParserResult[] {
  const matches = matchParsedResultsToEntries(entries, parsedResults);
  const resultsToPersist: EntryParserResult[] = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const entryItem = entries[i];

    if (!match) {
      console.warn(`Skipping ${entryItem.entry} (${entryItem.lang}): no valid AI result`);
      continue;
    }

    const { parsed } = match;
    const aiDisplayText = parsed.primary.displayText;
    const displayText = resolveDisplayText(entryItem.entry, aiDisplayText);
    const primaryRejected = displayText !== aiDisplayText;
    let parseFailed = primaryRejected;
    const rejectedNote = primaryRejected ? ` [rejected AI form="${aiDisplayText}"]` : '';

    const secondaryClasses: EntryParserSecondaryClass[] = [];
    for (const secondary of parsed.secondary) {
      const secondaryDisplay = resolveDisplayText(entryItem.entry, secondary.displayText);
      const secondaryRejected = secondaryDisplay !== secondary.displayText;
      if (secondaryRejected) {
        parseFailed = true;
      }
      if (secondaryDisplay === displayText) {
        console.log(
          `  skipping secondary ${entryItem.entry}: class=${secondary.entryType}, ` +
            `form=${secondaryDisplay} matches primary display text` +
            `${secondaryRejected ? ` [rejected AI form="${secondary.displayText}"]` : ''}`,
        );
        continue;
      }

      if (secondaryClasses.some((existing) => existing.secondaryClass === secondary.entryType)) {
        console.log(
          `  skipping secondary ${entryItem.entry}: class=${secondary.entryType}, ` +
            `form=${secondaryDisplay} duplicate class, keeping first` +
            `${secondaryRejected ? ` [rejected AI form="${secondary.displayText}"]` : ''}`,
        );
        continue;
      }

      console.log(
        `  secondary ${entryItem.entry}: class=${secondary.entryType}, form=${secondaryDisplay}` +
          `${secondary.baseForm ? `, base=${secondary.baseForm}` : ''}` +
          `${secondaryRejected ? ` [rejected AI form="${secondary.displayText}"]` : ''}`,
      );
      secondaryClasses.push({
        secondaryClass: secondary.entryType,
        secondaryDisplay,
        secondaryBaseForm: secondary.baseForm,
      });
    }

    const reviewedStatus = parseFailed ? 'Failed parse' : '1';
    const isNonsense = parsed.primary.entryType === 'Nonsense';
    resultsToPersist.push({
      entry: entryItem.entry,
      lang: entryItem.lang,
      displayText: isNonsense ? '' : displayText,
      entryType: parsed.primary.entryType,
      baseForm: parsed.primary.baseForm,
      isVulgar: parsed.isVulgar,
      reviewedStatus,
      secondaryClasses,
    });

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): type=${parsed.primary.entryType}, ` +
        `form=${isNonsense ? 'NULL' : displayText}${parsed.primary.baseForm ? `, base=${parsed.primary.baseForm}` : ''}, ` +
        `vulgar=${parsed.isVulgar}, secondary=${secondaryClasses.length}, ` +
        `status=${reviewedStatus}${rejectedNote}` +
        `${isNonsense ? ', cleared display_text and familiarity/unity/quality fields' : ''}`,
    );
  }

  return resultsToPersist;
}

async function processBatch(
  entries: EntryForEntryParser[],
  promptTemplate: string,
  provider: IAiProvider,
  requestLabel: string,
): Promise<number> {
  const promptData = entries.map((entryItem) => entryItem.entry).join('\n');
  const prompt = promptTemplate.replace('[[DATA]]', promptData);

  console.log(`${requestLabel}: sending entry parser prompt for ${entries.length} entries`);
  const aiResponse = await provider.generateResultsAsync(prompt);
  console.log(`${requestLabel}: received response (${aiResponse.length} characters)`);

  const parsedResults = parseEntryParser3Response(aiResponse);
  console.log(`${requestLabel}: parsed ${parsedResults.length} entry parser results`);

  if (parsedResults.length !== entries.length) {
    console.warn(
      `${requestLabel}: expected ${entries.length} results but parsed ${parsedResults.length}`,
    );
  }

  const resultsToPersist = buildResultsToPersist(entries, parsedResults);
  if (resultsToPersist.length === 0) {
    console.warn(`${requestLabel}: no valid entry parser results to persist`);
    return 0;
  }

  await upsertEntryParserResults(resultsToPersist);
  console.log(
    `${requestLabel}: updated display fields, vulgarity, reviewed_status, and secondary classes for ${resultsToPersist.length} entries`,
  );
  return resultsToPersist.length;
}

export async function entryParser(
  provider: IAiProvider = cursorProvider,
  maxItems: number = DEFAULT_MAX_ITEMS,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
  entryPattern?: string,
): Promise<void> {
  try {
    const concurrency = Math.max(1, parallelRequests);
    const pattern = entryPattern?.trim() || undefined;

    console.log(
      `Starting entry parser with provider ${provider.sourceAI} ` +
        `(max ${maxItems} AI requests, ${concurrency} parallel` +
        `${pattern ? `, pattern ${pattern}` : ''})...`,
    );

    const promptTemplate = await loadEntryParserPrompt3Async();

    let itemsCompleted = 0;
    let cycleNumber = 0;
    let shouldStop = false;

    while (itemsCompleted < maxItems && !shouldStop) {
      const remainingItems = maxItems - itemsCompleted;
      const requestsThisCycle = Math.min(concurrency, remainingItems);
      const selectLimit = requestsThisCycle * ENTRIES_PER_REQUEST;

      const entries = await getEntriesForEntryParser(selectLimit, pattern);
      if (entries.length === 0) {
        console.log(
          `No entries remaining whose reviewed_status does not start with 1` +
            `${pattern ? ` (pattern ${pattern})` : ''}`,
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
            return await processBatch(chunk, promptTemplate, provider, requestLabel);
          } catch (error) {
            if (isGeminiTimeoutError(error)) {
              cycleHadTimeout = true;
              console.warn(
                `${requestLabel}: AI request took more than 5 minutes; abandoning and continuing`,
              );
              return 0;
            }

            console.error(`Error processing entry parser ${requestLabel}:`, error);
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
    console.error('Fatal error in entryParser:', error);
    throw error;
  }
}
