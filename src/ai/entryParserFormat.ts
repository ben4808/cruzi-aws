export const ENTRY_PARSER_CATEGORIES = new Set([
  'Word',
  'Phrase',
  'Proper Name',
  'Acronym/Abbreviation',
  'Prefix/Suffix',
  'Nonsense',
]);

const ENTRY_PARSER_CLASS_ALIASES: Record<string, string> = {
  'Inflected Word': 'Word',
  'Inflected Phrase': 'Phrase',
};

const CLASSES_WITHOUT_BASE_FORM = new Set(['Prefix/Suffix', 'Nonsense']);

export interface ParsedEntryClass {
  entryType: string;
  displayText: string;
  baseForm?: string;
}

export interface ParsedEntryParser3Result {
  entry: string;
  isVulgar: boolean;
  primary: ParsedEntryClass;
  secondary: ParsedEntryClass[];
}

export function parseDisplayTextAndBaseForm(raw: string): { displayText: string; baseForm?: string } {
  const baseMatch = raw.match(/^(.+?)\s+\((.+)\)$/);
  if (baseMatch) {
    return {
      displayText: baseMatch[1].trim(),
      baseForm: baseMatch[2].trim(),
    };
  }
  return { displayText: raw.trim() };
}

export function parseVulgarity(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'yes' || normalized === 'y' || normalized === 'true') {
    return true;
  }
  if (normalized === 'no' || normalized === 'n' || normalized === 'false') {
    return false;
  }
  return null;
}

export function canonicalizeEntryParserType(raw: string): string | null {
  const mapped = ENTRY_PARSER_CLASS_ALIASES[raw] ?? raw;
  if (!ENTRY_PARSER_CATEGORIES.has(mapped)) {
    return null;
  }
  return mapped;
}

export function parseEntryClass(entryTypeRaw: string, displayRaw: string): ParsedEntryClass | null {
  const entryType = canonicalizeEntryParserType(entryTypeRaw);
  if (!entryType || !displayRaw) {
    return null;
  }

  const { displayText, baseForm } = parseDisplayTextAndBaseForm(displayRaw);
  if (!displayText) {
    return null;
  }

  if (!baseForm || CLASSES_WITHOUT_BASE_FORM.has(entryType)) {
    return { entryType, displayText };
  }

  return { entryType, displayText, baseForm };
}

function parseSecondaryClasses(parts: string[], startIndex: number): ParsedEntryClass[] {
  const secondary: ParsedEntryClass[] = [];
  for (let i = startIndex; i + 1 < parts.length; i += 2) {
    const parsedClass = parseEntryClass(parts[i], parts[i + 1]);
    if (parsedClass) {
      secondary.push(parsedClass);
    }
  }
  return secondary;
}

export function parseEntryParser3Line(line: string): ParsedEntryParser3Result | null {
  const parts = line.split(' : ').map((part) => part.trim());
  if (parts.length < 3 || !parts[0]) {
    return null;
  }

  const vulgarity = parts.length >= 4 ? parseVulgarity(parts[1]) : null;
  if (vulgarity !== null) {
    const primary = parseEntryClass(parts[2], parts[3]);
    if (!primary) {
      return null;
    }
    return {
      entry: parts[0],
      isVulgar: vulgarity,
      primary,
      secondary: parseSecondaryClasses(parts, 4),
    };
  }

  const primary = parseEntryClass(parts[1], parts[2]);
  if (!primary) {
    return null;
  }

  return {
    entry: parts[0],
    isVulgar: false,
    primary,
    secondary: parseSecondaryClasses(parts, 3),
  };
}

export function parseEntryParser3Response(response: string): ParsedEntryParser3Result[] {
  const results: ParsedEntryParser3Result[] = [];
  for (const line of response.split('\n').map((item) => item.trim()).filter((item) => item !== '')) {
    const parsed = parseEntryParser3Line(line);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}
