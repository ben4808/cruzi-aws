/*
1. Select all entries from the entry table with lang 'en' and that include accent or tilded characters in the entry field.
2. Remove the accents and tildes from all characters in the entries.
3. Upsert the entries into the entry table.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import { fixAccentedEntries, getEntriesWithAccents } from 'cruzi-db';
import { stripAccents } from './lib/utils';

const BATCH_SIZE = 100;

export async function accentFixer(): Promise<void> {
  try {
    console.log('Starting accent fixer...');

    let totalFixed = 0;
    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesWithAccents(BATCH_SIZE);
      if (entries.length === 0) {
        if (batchNumber === 0) {
          console.log('No entries found with accents in the entry key');
        }
        break;
      }

      batchNumber++;
      console.log(
        `Batch ${batchNumber}: found ${entries.length} accented entries`,
      );

      for (const entry of entries) {
        const cleaned = stripAccents(entry.entry);
        console.log(`  ${entry.entry} (${entry.lang}) -> ${cleaned}`);
      }

      const fixedCount = await fixAccentedEntries(entries);
      totalFixed += fixedCount;
      console.log(`Batch ${batchNumber}: fixed ${fixedCount} entries`);
    }

    console.log(`Accent fixer completed: ${totalFixed} entries fixed`);
  } catch (error) {
    console.error('Fatal error in accentFixer:', error);
    throw error;
  }
}
