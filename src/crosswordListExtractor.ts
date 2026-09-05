/*
Extracts a list of entries to make a crossword word list.

The entries will recieve 2 main classifications:
1. Gettable-ness
This measures how gettable an entry is for the average solver. Levels of gettable-ness are:
- Very Gettable: 
   Entry has unity bucket of Concept or Formula.
   Entry has familiarity bucket of Beginner Core, Ubiquitous, Active, or Colloquial.
- Likely Gettable:
   Entry has unity bucket of Concept, Collocation, Formular, or Partial.
   Entry has familiarity bucket of Common Name, Easy Collocation, or Inferred.
- Maybe Gettable:
   Entry has unity bucket of Concept, Collocation, Formula, Partial, or Variant.
   Entry has familiarity bucket of General Knowledge, Niche, or Variant.
- Not Gettable:
   Entry has a unity bucket of Concept, Collocation, Formula, or Partial.
   Entry has familiarity bucket of Obscure or Barely Exists.
- Not a Thing:
   Entry has a unity bucket of Non-unit or Nonsense.

2. Desirability
This measures how desirable an entry is for a crossword solver. Levels of desirability are:
- Prefer:
   Entry has a quality bucket of Idiomatic, Interesting, Appealing, Emotional, or Trendy.
- Normal:
   Entry has a quality bucket of Normal.
- Avoid:
   Entry has a quality bucket of Non-unit, Unfamiliar, Partial, Uncommon Inflection, or Clunky.

Go through the entry table and pull out all entries that don't have entry_type Nonsense or unity_bucket one of [Non-unit, Nonsense].
Also include parameters for max length and min length of the entries to include. Default min length 3 and max length 5.
Include a parameter to exclude obscure entries which would also exclude familiarity bucket of Obscure or Barely Exists. Default is true.
If unity_bucket or familiarity_bucket is not set, default gettable-ness to Maybe Gettable.
If quality_bucket is not set, default desirability to Normal.

Output the result as a CSV file in C:\Users\ben_z\Desktop\crossword_lists\list_<rondom 4 alphanumeric characters>.csv
There should be one entry per row. The entries should be sorted alphabetically.

The row format should be:
entry,gettable-ness,desirability

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { CrosswordListEntry, getCrosswordListEntries } from 'cruzi-db';

const OUTPUT_DIR = 'C:\\Users\\ben_z\\Desktop\\crossword_lists';

const VERY_GETTABLE_UNITY = new Set(['Concept', 'Formula']);
const LIKELY_GETTABLE_UNITY = new Set(['Concept', 'Collocation', 'Formula', 'Partial']);
const MAYBE_GETTABLE_UNITY = new Set(['Concept', 'Collocation', 'Formula', 'Partial', 'Variant']);
const NOT_GETTABLE_UNITY = new Set(['Concept', 'Collocation', 'Formula', 'Partial']);
const NOT_A_THING_UNITY = new Set(['Non-unit', 'Nonsense']);

const VERY_GETTABLE_FAMILIARITY = new Set(['Beginner Core', 'Ubiquitous', 'Active', 'Colloquial']);
const LIKELY_GETTABLE_FAMILIARITY = new Set(['Common Name', 'Easy Collocation', 'Inferred']);
const MAYBE_GETTABLE_FAMILIARITY = new Set(['General Knowledge', 'Niche', 'Variant']);
const NOT_GETTABLE_FAMILIARITY = new Set(['Obscure', 'Barely Exists']);

const PREFER_QUALITY = new Set(['Idiomatic', 'Interesting', 'Appealing', 'Emotional', 'Trendy']);
const AVOID_QUALITY = new Set(['Non-unit', 'Unfamiliar', 'Partial', 'Uncommon Inflection', 'Clunky']);

export type GettableNess =
  | 'Very Gettable'
  | 'Likely Gettable'
  | 'Maybe Gettable'
  | 'Not Gettable'
  | 'Not a Thing';

export type Desirability = 'Prefer' | 'Normal' | 'Avoid';

function isUnset(value: string | null): boolean {
  return value == null || value.trim() === '';
}

function classifyGettableNess(unityBucket: string | null, familiarityBucket: string | null): GettableNess {
  if (isUnset(unityBucket) || isUnset(familiarityBucket)) {
    return 'Maybe Gettable';
  }

  const unity = unityBucket as string;
  const familiarity = familiarityBucket as string;

  if (NOT_A_THING_UNITY.has(unity)) {
    return 'Not a Thing';
  }
  if (VERY_GETTABLE_UNITY.has(unity) && VERY_GETTABLE_FAMILIARITY.has(familiarity)) {
    return 'Very Gettable';
  }
  if (LIKELY_GETTABLE_UNITY.has(unity) && LIKELY_GETTABLE_FAMILIARITY.has(familiarity)) {
    return 'Likely Gettable';
  }
  if (MAYBE_GETTABLE_UNITY.has(unity) && MAYBE_GETTABLE_FAMILIARITY.has(familiarity)) {
    return 'Maybe Gettable';
  }
  if (NOT_GETTABLE_UNITY.has(unity) && NOT_GETTABLE_FAMILIARITY.has(familiarity)) {
    return 'Not Gettable';
  }
  return 'Maybe Gettable';
}

function classifyDesirability(qualityBucket: string | null): Desirability {
  if (isUnset(qualityBucket)) {
    return 'Normal';
  }

  const quality = qualityBucket as string;
  if (PREFER_QUALITY.has(quality)) {
    return 'Prefer';
  }
  if (quality === 'Normal') {
    return 'Normal';
  }
  if (AVOID_QUALITY.has(quality)) {
    return 'Avoid';
  }
  return 'Normal';
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
  maxLength: number = 5,
  excludeObscure: boolean = true,
): Promise<string> {
  console.log('Starting crossword list extraction...');
  console.log(
    `Parameters: minLength=${minLength}, maxLength=${maxLength}, excludeObscure=${excludeObscure}`,
  );

  console.log('Querying crossword list entries from the database...');
  const entries: CrosswordListEntry[] = await getCrosswordListEntries(
    minLength,
    maxLength,
    excludeObscure,
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
  };

  const progressInterval = Math.max(1, Math.floor(entries.length / 10) || 1);
  const lines: string[] = ['entry,gettable-ness,desirability'];

  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];
    const gettableNess = classifyGettableNess(row.unityBucket, row.familiarityBucket);
    const desirability = classifyDesirability(row.qualityBucket);

    counts[gettableNess] += 1;
    counts[desirability] += 1;
    if (isUnset(row.unityBucket) || isUnset(row.familiarityBucket)) {
      counts.defaultedGettable += 1;
    }
    if (isUnset(row.qualityBucket)) {
      counts.defaultedDesirability += 1;
    }

    lines.push(`${csvEscape(row.entry)},${csvEscape(gettableNess)},${csvEscape(desirability)}`);

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
  console.log(`Crossword list extraction completed: ${entries.length} rows written to ${outputPath}`);

  return outputPath;
}
