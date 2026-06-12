import { PublicationId } from 'cruzi-models';
import { parseCrosswordCompilerXml } from '../lib/crosswordCompilerXml';
import { formatDateKey2 } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

const PUZZLE_BASE_URL = 'https://api.puzzlenation.com/dailyPopCrosswords/puzzles/daily';
const API_KEY_URL = 'http://dailypopcrosswordsweb.puzzlenation.com/crosswordSetup.js';

let cachedApiKey: string | undefined;

function buildPuzzleUrl(date: Date): string {
  return `${PUZZLE_BASE_URL}/${formatDateKey2(date)}`;
}

async function getApiKey(): Promise<string> {
  if (cachedApiKey) {
    return cachedApiKey;
  }

  const response = await fetch(API_KEY_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Daily Pop API key (${response.status}).`);
  }

  const match = /const API_KEY = "([^"]+)"/.exec(await response.text());
  if (!match) {
    throw new Error('Could not find Daily Pop API key.');
  }

  cachedApiKey = match[1];
  return cachedApiKey;
}

export class DailyPopSource implements PuzzleSource {
  public id = 'DailyPop';
  public name = 'Daily Pop';

  public async getPuzzle(date: Date) {
    const url = buildPuzzleUrl(date);
    const response = await fetch(url, {
      headers: {
        'x-api-key': await getApiKey(),
      },
    });

    if (!response.ok) {
      return null;
    }

    const puzzle = parseCrosswordCompilerXml(await response.text(), {
      publicationId: this.id as PublicationId,
      date,
      sourceLink: url,
      defaultTitle: 'Daily Pop Crossword',
    });

    if (!puzzle) {
      throw new Error('Failed to parse Daily Pop puzzle data.');
    }

    return puzzle;
  }
}
