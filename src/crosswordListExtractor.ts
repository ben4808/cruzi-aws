/*
Extracts a list of entries to make a crossword word list.

The entries will recieve 2 main classifications:
1. Gettability
This measures how gettable an entry is for the average solver. Levels of gettability are defined below.
Pick the first level of gettability that applies to the entry. All criteria must be met for the level to be applied.

- Very Gettable (vg):
   Entry has unity bucket of Concept, Collocation, Formula, Variant
   Entry has familiarity bucket of Ubiquitous or Active.
   Entry does not have a Crossword bucket of Unexpected Form.
   Entry does not have a Classification of Contraction.
- Likely Gettable (lg):
   Entry has unity bucket of Concept, Collocation, Formula, Variant, Partial, Formulaic
   Entry has familiarity bucket of Ubiquitous, Active, Literal, Common Name, Regionalism, General Knowledge, Inferred
- Maybe Gettable (mg):
   Entry has familiarity bucket of Niche, or a familiarity bucket of Literal and the unity bucket is not Concept, Collocation, or Formula.
- Not Gettable (ng):
   Entry has familiarity bucket of Obscure.
- Not a Thing (nt):
   Entry has a classification of Nonsense or unity bucket of Nonsense or familiarity bucket of Nonsense.

2. Desirability
This measures how desirable an entry is for a crossword solver. If any one of the criteria is met, the level of desirability is applied. 
Pick the first level that applies to the item.
Levels of desirability are:

- Avoid (a):
   Entry has a crossword bucket of Contrived
   Entry has an entry_tags row with tag 'gross' or 'vulgar'.
- Penalty (pn):
   Entry has crossword bucket of Convenient or Uncommon Derivation
   Entry has an entry_tags row with tag 'sensitive'
- Slight Penalty (sp):
   Entry has its base form field non-null and non-empty.
   Entry has a classification of Acronym/Abbreviation.
- Prefer (p):
   Entry has a quality bucket of Idiomatic, Interesting, Feel-Good, or Trendy.
   Entry has a crossword bucket of High-Scrabble or Unexpected Form
- Normal (n):
   Everything else.

Query the entry table for entries that have display_text and classification.
There are parameters for max length and min length of the entries to include. Default min length 3 and max length 9.
There is also a parameter excludeItems parameter to potentially exclude obscure items from the list. If no excludeItems parameter is passed in, include all items. Possible values:
 - ExcludeNotAThing: Exclude entries with Gettability Not a Thing
 - ExcludeNotGettable: Exclude the items from ExcludeNotAThing plus entries with Gettability Not Gettable.
 - ExcludeMaybeGettable: Exclude the items from ExcludeNotGettable plus entries with Gettability Maybe Gettable.
There is also a parameter encryptData that, if true, encrypts the data using ChaCha20 with the key "LH6dMILZXzc" before writing to the CSV file.
If unity_bucket is not set, default Gettability to Maybe Gettable.
If familiarity_bucket is not set, default Gettability to Maybe Gettable.
If quality_bucket is not set, default desirability to Normal.

Output the result as a CSV file in C:\Users\ben_z\Desktop\crossword_lists\list_<rondom 4 alphanumeric characters>.csv (or .enc if encryptData is true)
There should be one entry per row. The entries should be sorted alphabetically.

The row format should be:
entry,gettableness,desirability

gettableness and desirability should be the codes for the gettableness and desirability levels, respectively.

Output messages to the console updating all progress.
All database operations should be done through Postgre functions in the cruzi-db package. Create new functions as needed.
cruzi-db/sql/schema.sql is the source of truth for the database schema.
Keep these requirements in the file.
*/

import { createCipheriv, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  CrosswordListEntry,
  CrosswordListExcludeItems,
  getCrosswordListEntries,
} from 'cruzi-db';

const OUTPUT_DIR = 'C:\\Users\\ben_z\\Desktop\\crossword_lists';
const ENCRYPT_KEY = 'LH6dMILZXzc';

const VERY_GETTABLE_UNITY = new Set(['Concept', 'Collocation', 'Formula', 'Variant']);
const LIKELY_GETTABLE_UNITY = new Set([
  'Concept',
  'Collocation',
  'Formula',
  'Variant',
  'Partial',
  'Formulaic',
]);
const CORE_UNITY = new Set(['Concept', 'Collocation', 'Formula']);

const VERY_GETTABLE_FAMILIARITY = new Set(['Ubiquitous', 'Active']);
const LIKELY_GETTABLE_FAMILIARITY = new Set([
  'Ubiquitous',
  'Active',
  'Literal',
  'Common Name',
  'Regionalism',
  'General Knowledge',
  'Inferred',
]);

const PREFER_QUALITY = new Set(['Idiomatic', 'Interesting', 'Feel-Good', 'Trendy']);

export type GettableNess =
  | 'Very Gettable'
  | 'Likely Gettable'
  | 'Maybe Gettable'
  | 'Not Gettable'
  | 'Not a Thing';

export type Desirability = 'Prefer' | 'Normal' | 'Slight Penalty' | 'Penalty' | 'Avoid';

export type GettableNessCode = 'vg' | 'lg' | 'mg' | 'ng' | 'nt';
export type DesirabilityCode = 'p' | 'n' | 'sp' | 'pn' | 'a';

export type ExcludeItems = CrosswordListExcludeItems;

const GETTABLE_CODES: Record<GettableNess, GettableNessCode> = {
  'Very Gettable': 'vg',
  'Likely Gettable': 'lg',
  'Maybe Gettable': 'mg',
  'Not Gettable': 'ng',
  'Not a Thing': 'nt',
};

const DESIRABILITY_CODES: Record<Desirability, DesirabilityCode> = {
  Prefer: 'p',
  Normal: 'n',
  'Slight Penalty': 'sp',
  Penalty: 'pn',
  Avoid: 'a',
};

const GETTABLE_RANK: Record<GettableNess, number> = {
  'Very Gettable': 0,
  'Likely Gettable': 1,
  'Maybe Gettable': 2,
  'Not Gettable': 3,
  'Not a Thing': 4,
};

function isUnset(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

function isNonsense(value: string | null | undefined): boolean {
  return !isUnset(value) && value === 'Nonsense';
}

export function classifyGettableNess(
  classification: string | null,
  unityBucket: string | null,
  familiarityBucket: string | null,
  crosswordBucket: string | null = null,
): GettableNess {
  if (isNonsense(classification) || isNonsense(unityBucket) || isNonsense(familiarityBucket)) {
    return 'Not a Thing';
  }
  if (isUnset(unityBucket) || isUnset(familiarityBucket)) {
    return 'Maybe Gettable';
  }

  const unity = unityBucket as string;
  const familiarity = familiarityBucket as string;

  if (
    VERY_GETTABLE_UNITY.has(unity)
    && VERY_GETTABLE_FAMILIARITY.has(familiarity)
    && crosswordBucket !== 'Unexpected Form'
    && classification !== 'Contraction'
  ) {
    return 'Very Gettable';
  }
  if (LIKELY_GETTABLE_UNITY.has(unity) && LIKELY_GETTABLE_FAMILIARITY.has(familiarity)) {
    return 'Likely Gettable';
  }
  if (
    familiarity === 'Niche'
    || (familiarity === 'Literal' && !CORE_UNITY.has(unity))
  ) {
    return 'Maybe Gettable';
  }
  if (familiarity === 'Obscure') {
    return 'Not Gettable';
  }
  return 'Maybe Gettable';
}

export function classifyDesirability(
  qualityBucket: string | null,
  baseForm: string | null = null,
  classification: string | null = null,
  crosswordBucket: string | null = null,
  hasAvoidTag: boolean = false,
  hasSensitiveTag: boolean = false,
): Desirability {
  if (crosswordBucket === 'Contrived' || hasAvoidTag) {
    return 'Avoid';
  }
  if (crosswordBucket === 'Convenient' || crosswordBucket === 'Uncommon Derivation' || hasSensitiveTag) {
    return 'Penalty';
  }
  if (!isUnset(baseForm) || classification === 'Acronym/Abbreviation') {
    return 'Slight Penalty';
  }
  if (
    (!isUnset(qualityBucket) && PREFER_QUALITY.has(qualityBucket as string))
    || crosswordBucket === 'High-Scrabble'
    || crosswordBucket === 'Unexpected Form'
  ) {
    return 'Prefer';
  }
  return 'Normal';
}

function shouldExclude(gettableNess: GettableNess, excludeItems?: ExcludeItems): boolean {
  if (!excludeItems) {
    return false;
  }
  if (excludeItems === 'ExcludeNotAThing') {
    return GETTABLE_RANK[gettableNess] >= GETTABLE_RANK['Not a Thing'];
  }
  if (excludeItems === 'ExcludeNotGettable') {
    return GETTABLE_RANK[gettableNess] >= GETTABLE_RANK['Not Gettable'];
  }
  if (excludeItems === 'ExcludeMaybeGettable') {
    return GETTABLE_RANK[gettableNess] >= GETTABLE_RANK['Maybe Gettable'];
  }
  return false;
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

function encryptChaCha20(plaintext: Buffer): Buffer {
  const key = Buffer.alloc(32);
  Buffer.from(ENCRYPT_KEY, 'utf8').copy(key);
  const nonce = Buffer.alloc(16);
  const cipher = createCipheriv('chacha20', key, nonce);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export async function crosswordListExtractor(
  minLength: number = 3,
  maxLength: number = 9,
  excludeItems?: ExcludeItems,
  encryptData: boolean = false,
): Promise<string> {
  console.log('Starting crossword list extraction...');
  console.log(
    `Parameters: minLength=${minLength}, maxLength=${maxLength}, excludeItems=${excludeItems ?? 'none'}, encryptData=${encryptData}`,
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
    'Slight Penalty': 0,
    Penalty: 0,
    Avoid: 0,
    defaultedDesirability: 0,
    excluded: 0,
  };

  const progressInterval = Math.max(1, Math.floor(entries.length / 10) || 1);
  const lines: string[] = ['entry,gettableness,desirability'];

  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];
    const gettableNess = classifyGettableNess(
      row.classification,
      row.unityBucket,
      row.familiarityBucket,
      row.crosswordBucket,
    );
    const desirability = classifyDesirability(
      row.qualityBucket,
      row.baseForm,
      row.classification,
      row.crosswordBucket,
      row.hasAvoidTag,
      row.hasSensitiveTag,
    );

    if (shouldExclude(gettableNess, excludeItems)) {
      counts.excluded += 1;
    } else {
      counts[gettableNess] += 1;
      counts[desirability] += 1;
      if (
        gettableNess !== 'Not a Thing'
        && (isUnset(row.unityBucket) || isUnset(row.familiarityBucket))
      ) {
        counts.defaultedGettable += 1;
      }
      if (isUnset(row.qualityBucket)) {
        counts.defaultedDesirability += 1;
      }

      lines.push(
        [
          csvEscape(row.entry),
          GETTABLE_CODES[gettableNess],
          DESIRABILITY_CODES[desirability],
        ].join(','),
      );
    }

    if ((i + 1) % progressInterval === 0 || i + 1 === entries.length) {
      console.log(`Classified ${i + 1}/${entries.length} entries`);
    }
  }

  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
  const extension = encryptData ? '.enc' : '.csv';
  const outputPath = path.join(OUTPUT_DIR, `list_${randomListId()}${extension}`);
  const csv = lines.join('\n') + '\n';

  if (encryptData) {
    console.log(`Encrypting CSV with ChaCha20 and writing to ${outputPath}`);
    await fs.promises.writeFile(outputPath, encryptChaCha20(Buffer.from(csv, 'utf8')));
  } else {
    console.log(`Writing CSV to ${outputPath}`);
    await fs.promises.writeFile(outputPath, csv, 'utf8');
  }

  console.log('Gettable-ness counts:', {
    vg: counts['Very Gettable'],
    lg: counts['Likely Gettable'],
    mg: counts['Maybe Gettable'],
    ng: counts['Not Gettable'],
    nt: counts['Not a Thing'],
    excluded: counts.excluded,
    defaultedUnsetFields: counts.defaultedGettable,
  });
  console.log('Desirability counts:', {
    p: counts.Prefer,
    n: counts.Normal,
    sp: counts['Slight Penalty'],
    pn: counts.Penalty,
    a: counts.Avoid,
    defaultedUnsetFields: counts.defaultedDesirability,
  });
  console.log(`Crossword list extraction completed: ${lines.length - 1} rows written to ${outputPath}`);

  return outputPath;
}
