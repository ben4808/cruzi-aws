import { entryToAllCaps, stripAccents } from './utils';

export function phraseIdentityKeys(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const keys = new Set<string>([trimmed, stripAccents(trimmed).toLowerCase()]);
  const allCaps = entryToAllCaps(trimmed);
  if (allCaps) {
    keys.add(allCaps);
  }
  return [...keys];
}

export function matchParsedResultsByIdentity<TInput, TParsed>(
  inputs: TInput[],
  parsedResults: TParsed[],
  getInputTexts: (input: TInput) => string[],
  getParsedTexts: (parsed: TParsed) => string[],
): Array<{ input: TInput; parsed: TParsed } | null> {
  const unmatched = [...parsedResults];
  const matches: Array<{ input: TInput; parsed: TParsed } | null> = inputs.map(() => null);

  // Exact matches are claimed first so that forms differing only by case or accents
  // (IDS vs IDs, crocs vs Crocs) each keep their own result.
  const passes: Array<(text: string) => string[]> = [
    (text) => (text.trim() ? [text.trim()] : []),
    phraseIdentityKeys,
  ];

  for (const toKeys of passes) {
    inputs.forEach((input, inputIndex) => {
      if (matches[inputIndex]) {
        return;
      }

      const inputKeys = new Set(getInputTexts(input).flatMap(toKeys));
      const matchIndex = unmatched.findIndex((parsed) =>
        getParsedTexts(parsed).some((text) => toKeys(text).some((key) => inputKeys.has(key))),
      );
      if (matchIndex === -1) {
        return;
      }

      const [parsed] = unmatched.splice(matchIndex, 1);
      matches[inputIndex] = { input, parsed };
    });
  }

  return matches;
}

export function matchPhrasesToParsed<TParsed>(
  phrases: string[],
  parsedResults: TParsed[],
  getParsedTexts: (parsed: TParsed) => string[],
): Array<{ phrase: string; parsed: TParsed } | null> {
  return matchParsedResultsByIdentity(
    phrases,
    parsedResults,
    (phrase) => [phrase],
    getParsedTexts,
  ).map((match) => (match ? { phrase: match.input, parsed: match.parsed } : null));
}
