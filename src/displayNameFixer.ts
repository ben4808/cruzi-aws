/*
Steps:
1. Select all entries that have a display_text field that doesn't match the entry itself.
The display_text, if you remove all punctuation and spaces, un-accent and un-tilde all charcters, and uppercase it
should match the entry exactly. We want to select all entries that don't match this criteria.

2. For all such entries, set a few fields to null: display_text, idiomacity_score, familiarity_score, quality_score, entry_type, root_entry.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import {
  getEntriesWithMismatchedDisplayText,
  resetEntryDisplayFields,
} from 'cruzi-db';

const BATCH_SIZE = 100;

export async function displayNameFixer(): Promise<void> {
  try {
    console.log('Starting display name fixer...');

    let totalReset = 0;
    let batchNumber = 0;

    while (true) {
      const entries = await getEntriesWithMismatchedDisplayText(BATCH_SIZE);
      if (entries.length === 0) {
        if (batchNumber === 0) {
          console.log('No entries found with mismatched display_text');
        }
        break;
      }

      batchNumber++;
      console.log(
        `Batch ${batchNumber}: found ${entries.length} entries with mismatched display_text`,
      );

      for (const entry of entries) {
        console.log(
          `  Resetting ${entry.entry} (${entry.lang}): display_text was "${entry.displayText}"`,
        );
      }

      const resetCount = await resetEntryDisplayFields(entries);
      totalReset += resetCount;
      console.log(`Batch ${batchNumber}: reset ${resetCount} entries`);
    }

    console.log(`Display name fixer completed: ${totalReset} entries reset`);
  } catch (error) {
    console.error('Fatal error in displayNameFixer:', error);
    throw error;
  }
}
