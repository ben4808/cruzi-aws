/*
Extracts a list of entries to make a crossword word list.

The entries will recieve 2 main classifications:
1. Gettability
This measures how gettable an entry is for the average solver. Levels of gettability are defined below.
Pick the first level of gettability that applies to the entry.

- Very Gettable: 
   Entry has unity bucket of Concept or Collocation.
   Entry has familiarity bucket of Ubiquitous or Active.
- Likely Gettable:
   Entry has unity bucket of Concept, Collocation, Formula, or Partial.
   Entry has familiarity bucket of Ubiquitous, Active, Literal, Common Name, General Knowledge, or Inferred.
- Maybe Gettable:
   Entry has familiarity bucket of Niche, Literal, or Non-Unit.
- Not Gettable:
   Entry has familiarity bucket of Obscure or Barely Exists.
- Not a Thing:
   Entry has a classification of Nonsense or unity bucket of Nonsense or familiarity bucket of Nonsense.

2. Desirability
This measures how desirable an entry is for a crossword solver. Levels of desirability are:

- Prefer:
   Entry has a quality bucket of Idiomatic, Interesting, Feel-Good, or Trendy.
- Normal:
   Entry has a quality bucket of Normal.
- Avoid:
   Entry has a quality bucket of Non-unit, Uncommon Derivation, or Clunky
   AND/OR Entry has an entry_tags row with tag 'breakfast_test' or 'vulgar'.

Query the entry table for entries that have display_text and classification.
There are parameters for max length and min length of the entries to include. Default min length 3 and max length 9.
There is also a parameter excludeItems parameter to potentially exclude obscure items from the list. If no excludeItems parameter is passed in, include all items. Possible values:
 - ExcludeNonUnit: Exclude entries with classification of Nonsense or unity_bucket one of [Non-unit, Nonsense] or familiarity_bucket of Nonsense.
 - ExcludeObscure: Exclude the items from ExcludeNonUnit plus entries with familiarity bucket of Obscure or Barely Exists.
If unity_bucket is not set, default Gettability to Maybe Gettable.
If familiarity_bucket is not set, default Gettability to Maybe Gettable.
If quality_bucket is not set, default desirability to Normal.

Output the result as a CSV file in C:\Users\ben_z\Desktop\crossword_lists\list_<rondom 4 alphanumeric characters>.csv
There should be one entry per row. The entries should be sorted alphabetically.

The row format should be:
entry,gettableness,desirability,abbr,sensitive,crosswordese

abbr is y if the entry classification is Acronym/Abbreviation, otherwise n.
sensitive is y if the entry has an entry_tags row with tag 'sensitive', otherwise n.
crosswordese is y if the entry has an entry_tags row with tag 'crosswordese', otherwise n.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  CrosswordListEntry,
  CrosswordListExcludeItems,
  getCrosswordListEntries,
} from 'cruzi-db';

const OUTPUT_DIR = 'C:\\Users\\ben_z\\Desktop\\crossword_lists';

const VERY_GETTABLE_UNITY = new Set(['Concept', 'Collocation']);
const LIKELY_GETTABLE_UNITY = new Set(['Concept', 'Collocation', 'Formula', 'Partial']);

const VERY_GETTABLE_FAMILIARITY = new Set(['Ubiquitous', 'Active']);
const LIKELY_GETTABLE_FAMILIARITY = new Set([
  'Ubiquitous',
  'Active',
  'Literal',
  'Common Name',
  'General Knowledge',
  'Inferred',
]);
const MAYBE_GETTABLE_FAMILIARITY = new Set(['Niche', 'Literal', 'Non-Unit', 'Non-unit']);
const NOT_GETTABLE_FAMILIARITY = new Set(['Obscure', 'Barely Exists']);

const PREFER_QUALITY = new Set(['Idiomatic', 'Interesting', 'Feel-Good', 'Trendy']);
const NORMAL_QUALITY = new Set(['Normal']);
const AVOID_QUALITY = new Set(['Non-unit', 'Uncommon Derivation', 'Clunky']);

export type GettableNess =
  | 'Very Gettable'
  | 'Likely Gettable'
  | 'Maybe Gettable'
  | 'Not Gettable'
  | 'Not a Thing';

export type Desirability = 'Prefer' | 'Normal' | 'Avoid';

export type ExcludeItems = CrosswordListExcludeItems;

function isUnset(value: string | null): boolean {
  return value == null || value.trim() === '';
}

function isNonsense(value: string | null): boolean {
  return !isUnset(value) && value === 'Nonsense';
}

function classifyGettableNess(
  classification: string | null,
  unityBucket: string | null,
  familiarityBucket: string | null,
): GettableNess {
  if (isNonsense(classification) || isNonsense(unityBucket) || isNonsense(familiarityBucket)) {
    return 'Not a Thing';
  }
  if (isUnset(unityBucket) || isUnset(familiarityBucket)) {
    return 'Maybe Gettable';
  }

  const unity = unityBucket as string;
  const familiarity = familiarityBucket as string;

  if (VERY_GETTABLE_UNITY.has(unity) && VERY_GETTABLE_FAMILIARITY.has(familiarity)) {
    return 'Very Gettable';
  }
  if (LIKELY_GETTABLE_UNITY.has(unity) && LIKELY_GETTABLE_FAMILIARITY.has(familiarity)) {
    return 'Likely Gettable';
  }
  if (MAYBE_GETTABLE_FAMILIARITY.has(familiarity)) {
    return 'Maybe Gettable';
  }
  if (NOT_GETTABLE_FAMILIARITY.has(familiarity)) {
    return 'Not Gettable';
  }
  return 'Maybe Gettable';
}

function classifyDesirability(qualityBucket: string | null, hasAvoidTag: boolean): Desirability {
  if (hasAvoidTag || (!isUnset(qualityBucket) && AVOID_QUALITY.has(qualityBucket as string))) {
    return 'Avoid';
  }
  if (isUnset(qualityBucket)) {
    return 'Normal';
  }

  const quality = qualityBucket as string;
  if (PREFER_QUALITY.has(quality)) {
    return 'Prefer';
  }
  if (NORMAL_QUALITY.has(quality)) {
    return 'Normal';
  }
  return 'Normal';
}

function yn(value: boolean): string {
  return value ? 'y' : 'n';
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function randomListId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = randomBytes(4);
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}

export async function crosswordListExtractor(
  minLength: number = 3,
  maxLength: number = 9,
  excludeItems?: ExcludeItems,
): Promise<string> {
  console.log('Starting crossword list extraction...');
  console.log(
    `Parameters: minLength=${minLength}, maxLength=${maxLength}, excludeItems=${excludeItems ?? 'none'}`,
  );

  console.log('Querying crossword list entries from the database...');
  const entries: CrosswordListEntry[] = await getCrosswordListEntries(
    minLength,
    maxLength,
    excludeItems,
  );
  console.log(`Fetched ${entries.length} entries`);

  if (entries.length === 0) {
    console.log('No matching entries found; writing header-only CSV');
  }

  const counts = {
    'Very Gettable': 0,
    'Likely Gettable': 0,
    'Maybe Gettable': 0,
    'Not Gettable': 0,
    'Not a Thing': 0,
    defaultedGettable: 0,
    Prefer: 0,
    Normal: 0,
    Avoid: 0,
    defaultedDesirability: 0,
    abbreviation: 0,
    sensitive: 0,
    crosswordese: 0,
  };

  const progressInterval = Math.max(1, Math.floor(entries.length / 10) || 1);
  const lines: string[] = ['entry,gettableness,desirability,abbr,sensitive,crosswordese'];

  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];
    const gettableNess = classifyGettableNess(row.classification, row.unityBucket, row.familiarityBucket);
    const desirability = classifyDesirability(row.qualityBucket, row.hasAvoidTag);

    counts[gettableNess] += 1;
    counts[desirability] += 1;
    if (row.isAbbreviation) counts.abbreviation += 1;
    if (row.isSensitive) counts.sensitive += 1;
    if (row.isCrosswordese) counts.crosswordese += 1;
    if (
      gettableNess !== 'Not a Thing' &&
      (isUnset(row.unityBucket) || isUnset(row.familiarityBucket))
    ) {
      counts.defaultedGettable += 1;
    }
    if (isUnset(row.qualityBucket)) {
      counts.defaultedDesirability += 1;
    }

    lines.push(
      [
        csvEscape(row.entry),
        csvEscape(gettableNess),
        csvEscape(desirability),
        yn(row.isAbbreviation),
        yn(row.isSensitive),
        yn(row.isCrosswordese),
      ].join(','),
    );

    if ((i + 1) % progressInterval === 0 || i + 1 === entries.length) {
      console.log(`Classified ${i + 1}/${entries.length} entries`);
    }
  }

  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, `list_${randomListId()}.csv`);
  console.log(`Writing CSV to ${outputPath}`);
  await fs.promises.writeFile(outputPath, lines.join('\n') + '\n', 'utf8');

  console.log('Gettable-ness counts:', {
    'Very Gettable': counts['Very Gettable'],
    'Likely Gettable': counts['Likely Gettable'],
    'Maybe Gettable': counts['Maybe Gettable'],
    'Not Gettable': counts['Not Gettable'],
    'Not a Thing': counts['Not a Thing'],
    defaultedUnsetFields: counts.defaultedGettable,
  });
  console.log('Desirability counts:', {
    Prefer: counts.Prefer,
    Normal: counts.Normal,
    Avoid: counts.Avoid,
    defaultedUnsetFields: counts.defaultedDesirability,
  });
  console.log('Flag counts:', {
    abbreviation: counts.abbreviation,
    sensitive: counts.sensitive,
    crosswordese: counts.crosswordese,
  });
  console.log(`Crossword list extraction completed: ${entries.length} rows written to ${outputPath}`);

  return outputPath;
}
