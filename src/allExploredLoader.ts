/*
Steps:

1. Load into memory the file C:\Users\ben_z\Downloads\AllExplored_2.dict. Each line is of the form <entry>;<score>
2. Strip off the score and create a set of Entry objects (all in English)
3. Ladd all entries into the Entry table in the database. (Batches of 1000 entries at a time).
*/

import fs from 'fs';
import { upsertEntries } from 'cruzi-db';
import { Entry } from 'cruzi-models';
import { batchArray } from './lib/utils';

const DICT_FILE_PATH = 'C:\\Users\\ben_z\\Downloads\\AllExplored_2.dict';
const BATCH_SIZE = 1000;
const LANG = 'en';

export async function allExploredLoader(): Promise<void> {
  try {
    console.log('Starting AllExplored loader...');

    const content = await fs.promises.readFile(DICT_FILE_PATH, 'utf-8');
    const lines = content.split('\n').filter((line) => line.trim() !== '');

    const entrySet = new Set<string>();
    for (const line of lines) {
      const semicolonIndex = line.indexOf(';');
      const entryText = (semicolonIndex >= 0 ? line.slice(0, semicolonIndex) : line).trim();
      if (entryText) {
        entrySet.add(entryText);
      }
    }

    const entries: Entry[] = Array.from(entrySet).map((entry) => ({
      entry,
      lang: LANG,
    }));

    console.log(`Loaded ${entries.length} unique English entries from ${DICT_FILE_PATH}`);

    const batches = batchArray(entries, BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      await upsertEntries(batch);
      console.log(`Persisted batch ${i + 1}/${batches.length} (${batch.length} entries)`);
    }

    console.log('AllExplored loader completed');
  } catch (error) {
    console.error('Fatal error in allExploredLoader:', error);
    throw error;
  }
}
