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
  const matches: Array<{ input: TInput; parsed: TParsed } | null> = [];

  for (const input of inputs) {
    const inputKeys = new Set(
      getInputTexts(input).flatMap((text) => phraseIdentityKeys(text)),
    );

    const matchIndex = unmatched.findIndex((parsed) =>
      getParsedTexts(parsed).some((text) =>
        phraseIdentityKeys(text).some((key) => inputKeys.has(key)),
      ),
    );

    if (matchIndex === -1) {
      matches.push(null);
      continue;
    }

    const [parsed] = unmatched.splice(matchIndex, 1);
    matches.push({ input, parsed });
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
