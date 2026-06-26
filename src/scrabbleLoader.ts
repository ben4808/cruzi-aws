/*

1. Load the 2 word list files from C:\Users\ben_z\Desktop\naspa.csv and C:\Users\ben_z\Desktop\csw.csv.
2. Combine and deduplicate the lists into a single Scrabble word list.
3. In batches of 1000:
    1. Query the entry table for entries in the batches that already exist.
    2. For entries that do NOT exist, insert them into the entry table and also insert an entry_tag record with the tag "scrabble".

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.

*/

import fs from 'fs';
import { getEntries, GetEntriesInput, insertScrabbleEntries, ScrabbleEntryInsertData } from 'cruzi-db';
import { batchArray } from './lib/utils';

const NASPA_FILE_PATH = 'C:\\Users\\ben_z\\Desktop\\naspa.csv';
const CWS_FILE_PATH = 'C:\\Users\\ben_z\\Desktop\\csw.csv';
const BATCH_SIZE = 1000;    
const LANG = 'en';

async function loadWordListFile(filePath: string): Promise<string[]> {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return content.split('\n').map((line) => line.trim());
}

function toScrabbleEntry(word: string): ScrabbleEntryInsertData {
  return {
    entry: word,
    lang: LANG,
    length: word.length,
    display_text: word,
  };
}

export async function scrabbleLoader(): Promise<void> {
  try {
    console.log('Starting Scrabble loader...');

    const [naspaWords, cwsWords] = await Promise.all([
      loadWordListFile(NASPA_FILE_PATH),
      loadWordListFile(CWS_FILE_PATH),
    ]);

    console.log(`Loaded ${naspaWords.length} words from ${NASPA_FILE_PATH}`);
    console.log(`Loaded ${cwsWords.length} words from ${CWS_FILE_PATH}`);

    const uniqueWords = Array.from(new Set([...naspaWords, ...cwsWords])).sort();
    console.log(`Combined into ${uniqueWords.length} unique Scrabble words`);

    const batches = batchArray(uniqueWords, BATCH_SIZE);
    let totalInserted = 0;
    let totalSkipped = 0;

    for (let i = 0; i < batches.length; i++) {
      const batchWords = batches[i];
      const batchNumber = i + 1;

      const lookupItems: GetEntriesInput[] = batchWords.map((word) => ({
        entry: word,
        lang: LANG,
      }));
      const existingEntries = await getEntries(lookupItems);
      const existingKeys = new Set(existingEntries.map((entry) => `${entry.entry}|${entry.lang}`));

      const newWords = batchWords.filter((word) => !existingKeys.has(`${word}|${LANG}`));
      const skippedCount = batchWords.length - newWords.length;

      if (newWords.length > 0) {
        await insertScrabbleEntries(newWords.map(toScrabbleEntry));
      }

      totalInserted += newWords.length;
      totalSkipped += skippedCount;

      console.log(
        `Batch ${batchNumber}/${batches.length}: inserted ${newWords.length}, skipped ${skippedCount} existing (${batchWords.length} checked)`,
      );
    }

    console.log(
      `Scrabble loader completed: ${totalInserted} inserted, ${totalSkipped} already existed, ${uniqueWords.length} total unique words`,
    );
  } catch (error) {
    console.error('Fatal error in scrabbleLoader:', error);
    throw error;
  }
}
