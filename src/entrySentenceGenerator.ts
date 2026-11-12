/*
Tasks:
1. Query all entries from the database that have length 3 and familiarity bucket Ubiquitous and
 no entries in the entry_sentence table.
2. Build prompts to entry_sentences_prompt.txt for the entries. Send 5 entries per prompt and send up to 8
 prompts concurrently. Store the results in the entry_sentence table. Obviously the language codes stores will be 'en' and 'es'.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import fs from 'fs';
import {
  addEntrySentences,
  getEntriesForEntrySentenceGenerator,
  EntryForEntrySentenceGenerator,
  EntrySentenceInput,
} from 'cruzi-db';
import { CursorAiProvider } from './ai/cursor';
import { IAiProvider } from './ai/IAiProvider';
import { matchParsedResultsByIdentity } from './lib/resultMatching';
import {
  batchArray,
  GENERATOR_AI_REQUEST_TIMEOUT_MS,
  isAbandonableAiError,
  waitIfUnauthorized,
  withAiFailureHandling,
} from './lib/utils';

const ENTRIES_PER_REQUEST = 5;
const DEFAULT_PARALLEL_REQUESTS = 8;
const MIN_SENTENCE_PAIRS = 3;
const SOURCE_LANG = 'en';
const TRANSLATION_LANG = 'es';

export interface ParsedEntrySentences {
  wordPhrase: string;
  sentences: Array<{
    english: string;
    spanish: string;
  }>;
}

const cursorProvider = new CursorAiProvider();

async function loadEntrySentencesPromptAsync(): Promise<string> {
  try {
    return await fs.promises.readFile('./src/ai/entry_sentences_prompt.txt', 'utf-8');
  } catch (err) {
    console.error('Error reading entry sentences prompt file:', err);
    throw err;
  }
}

export function parseEntrySentencesResponse(response: string): ParsedEntrySentences[] {
  const normalized = response.replace(/```(?:\w+)?/g, '').trim();
  const lines = normalized.split('\n');
  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const line of lines) {
    if (line.trim() === '') {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
    } else {
      currentBlock.push(line);
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  const parsedResults: ParsedEntrySentences[] = [];

  for (const block of blocks) {
    const filteredLines = block.map((line) => line.trim()).filter((line) => line !== '');
    if (filteredLines.length === 0) {
      continue;
    }

    const wordPhrase = filteredLines[0];
    const sentences: Array<{ english: string; spanish: string }> = [];

    for (let i = 1; i < filteredLines.length; i += 2) {
      if (i + 1 >= filteredLines.length) {
        break;
      }
      sentences.push({
        english: filteredLines[i],
        spanish: filteredLines[i + 1],
      });
    }

    if (sentences.length < MIN_SENTENCE_PAIRS) {
      console.warn(
        `Expected at least ${MIN_SENTENCE_PAIRS} sentence pairs but got ${sentences.length} for ${wordPhrase}`,
      );
      continue;
    }

    parsedResults.push({ wordPhrase, sentences });
  }

  return parsedResults;
}

function matchParsedResultsToEntries(
  entries: EntryForEntrySentenceGenerator[],
  parsedResults: ParsedEntrySentences[],
): Array<{ entry: EntryForEntrySentenceGenerator; parsed: ParsedEntrySentences } | null> {
  return matchParsedResultsByIdentity(
    entries,
    parsedResults,
    (entryItem) => [entryItem.displayText, entryItem.entry],
    (parsed) => [parsed.wordPhrase],
  ).map((match) => (match ? { entry: match.input, parsed: match.parsed } : null));
}

export function buildSentencesToPersist(
  entries: EntryForEntrySentenceGenerator[],
  parsedResults: ParsedEntrySentences[],
): EntrySentenceInput[] {
  const matches = matchParsedResultsToEntries(entries, parsedResults);
  const sentencesToPersist: EntrySentenceInput[] = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const entryItem = entries[i];

    if (!match) {
      console.warn(`Skipping ${entryItem.entry} (${entryItem.lang}): no valid AI result`);
      continue;
    }

    const { parsed } = match;
    for (const pair of parsed.sentences) {
      const sourceIsSpanish = entryItem.lang === TRANSLATION_LANG;
      sentencesToPersist.push({
        entry: entryItem.entry,
        originalLang: sourceIsSpanish ? TRANSLATION_LANG : SOURCE_LANG,
        originalSentence: sourceIsSpanish ? pair.spanish : pair.english,
        translatedLang: sourceIsSpanish ? SOURCE_LANG : TRANSLATION_LANG,
        translatedSentence: sourceIsSpanish ? pair.english : pair.spanish,
      });
    }

    console.log(
      `Processed ${entryItem.entry} (${entryItem.lang}): ${parsed.sentences.length} ` +
        `${SOURCE_LANG}/${TRANSLATION_LANG} sentence pairs`,
    );
  }

  return sentencesToPersist;
}

async function processBatch(
  entries: EntryForEntrySentenceGenerator[],
  promptTemplate: string,
  provider: IAiProvider,
  requestLabel: string,
): Promise<number> {
  const promptData = entries.map((entryItem) => entryItem.displayText).join('\n');
  const prompt = promptTemplate.replace('[[WORDS AND PHRASES]]', promptData);

  console.log(`${requestLabel}: sending entry sentence prompt for ${entries.length} entries`);
  const aiResponse = await withAiFailureHandling(provider).generateResultsAsync(
    prompt,
    GENERATOR_AI_REQUEST_TIMEOUT_MS,
  );
  console.log(`${requestLabel}: received response (${aiResponse.length} characters)`);

  const parsedResults = parseEntrySentencesResponse(aiResponse);
  console.log(`${requestLabel}: parsed ${parsedResults.length} entry sentence results`);

  if (parsedResults.length !== entries.length) {
    console.warn(
      `${requestLabel}: expected ${entries.length} results but parsed ${parsedResults.length}`,
    );
  }

  const sentencesToPersist = buildSentencesToPersist(entries, parsedResults);
  if (sentencesToPersist.length === 0) {
    console.warn(`${requestLabel}: no valid entry sentences to persist`);
    return 0;
  }

  const inserted = await addEntrySentences(sentencesToPersist);
  console.log(`${requestLabel}: stored ${inserted} entry_sentence rows`);
  return inserted;
}

export async function entrySentenceGenerator(
  provider: IAiProvider = cursorProvider,
  parallelRequests: number = DEFAULT_PARALLEL_REQUESTS,
): Promise<void> {
  try {
    const concurrency = Math.max(1, Math.min(DEFAULT_PARALLEL_REQUESTS, parallelRequests));

    console.log(
      `Starting entry sentence generation with provider ${provider.sourceAI} ` +
        `(${ENTRIES_PER_REQUEST} entries per prompt, ${concurrency} parallel)...`,
    );

    const promptTemplate = await loadEntrySentencesPromptAsync();
    let requestsCompleted = 0;
    let cycleNumber = 0;
    let shouldStop = false;
    let totalRowsInserted = 0;

    while (!shouldStop) {
      const selectLimit = concurrency * ENTRIES_PER_REQUEST;
      const entries = await getEntriesForEntrySentenceGenerator(selectLimit);
      if (entries.length === 0) {
        console.log(
          'No length-3 Ubiquitous entries remaining without entry_sentence rows',
        );
        break;
      }

      const chunks = batchArray(entries, ENTRIES_PER_REQUEST);
      cycleNumber++;
      console.log(
        `Cycle ${cycleNumber}: ${chunks.length} parallel AI requests ` +
          `(${entries.length} entries); ${requestsCompleted} requests completed so far`,
      );

      const cycleAiErrors: unknown[] = [];
      const persistedCounts = await Promise.all(
        chunks.map(async (chunk, index) => {
          const requestNumber = requestsCompleted + index + 1;
          const requestLabel = `Request ${requestNumber}`;

          try {
            return await processBatch(chunk, promptTemplate, provider, requestLabel);
          } catch (error) {
            if (isAbandonableAiError(error)) {
              cycleAiErrors.push(error);
              console.warn(
                `${requestLabel}: AI request timed out or failed; abandoning and continuing:`,
                error instanceof Error ? error.message : error,
              );
              return 0;
            }

            console.error(`${requestLabel}: error processing entry sentences:`, error);
            shouldStop = true;
            return 0;
          }
        }),
      );

      requestsCompleted += chunks.length;
      const cycleInserted = persistedCounts.reduce((sum, count) => sum + count, 0);
      totalRowsInserted += cycleInserted;

      if (!shouldStop) {
        await waitIfUnauthorized(cycleAiErrors, `Cycle ${cycleNumber}`);
      }

      if (cycleInserted === 0) {
        console.warn(
          `No entry sentences persisted in cycle ${cycleNumber}; stopping to avoid repeating failed entries`,
        );
        break;
      }
    }

    console.log(
      `Stopped after ${requestsCompleted} AI requests; stored ${totalRowsInserted} entry_sentence rows`,
    );
  } catch (error) {
    console.error('Fatal error in entrySentenceGenerator:', error);
    throw error;
  }
}
