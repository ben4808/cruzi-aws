import { PublicationId, ScrapedPuzzle } from 'cruzi-models';
import { parseCrosswordCompilerXml } from '../lib/crosswordCompilerXml';
import { formatDateKey } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

const USER_AGENT = 'cruzi-aws-crossword-scraper';

function buildSimplyDailySourceLink(date: Date): string {
  return `https://simplydailypuzzles.com/daily-crossword/index.html?puzz=dc1-${formatDateKey(date)}`;
}

function buildSimplyDailyJsUrl(date: Date): string {
  const month = formatDateKey(date).slice(0, 7);
  return `https://simplydailypuzzles.com/daily-crossword/puzzles/${month}/dc1-${formatDateKey(date)}.js`;
}

async function fetchSimplyDailyPuzzle(
  date: Date,
  options: {
    publicationId: PublicationId;
    defaultTitle: string;
  },
): Promise<ScrapedPuzzle | null> {
  const sourceLink = buildSimplyDailySourceLink(date);
  const jsUrl = buildSimplyDailyJsUrl(date);
  const response = await fetch(jsUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    return null;
  }

  const jsText = await response.text();
  const prefix = 'var CrosswordPuzzleData = "';
  if (!jsText.startsWith(prefix)) {
    throw new Error(`Unexpected Simply Daily puzzle response from ${jsUrl}`);
  }

  const encodedXml = jsText.slice(prefix.length, -'";'.length).replace(/\\/g, '');
  const puzzle = parseCrosswordCompilerXml(encodedXml, {
    publicationId: options.publicationId,
    date,
    sourceLink,
    defaultTitle: options.defaultTitle,
  });

  if (!puzzle) {
    throw new Error('Failed to parse Simply Daily puzzle data.');
  }

  return puzzle;
}

export class SimplyDailySource implements PuzzleSource {
  public id = 'SimplyDaily';
  public name = 'Simply Daily Puzzles';

  public getPuzzle(date: Date) {
    return fetchSimplyDailyPuzzle(date, {
      publicationId: this.id as PublicationId,
      defaultTitle: 'Simply Daily',
    });
  }
}
