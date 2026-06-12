import { parse } from 'node-html-parser';
import { PublicationId, ScrapedPuzzle } from 'cruzi-models';
import { fetchAmuseLabsPuzzle } from '../lib/amuseLabs';
import { PuzzleSource } from '../scraper/PuzzleSource';

const USER_AGENT = 'cruzi-aws-crossword-scraper';

function buildCrosswordClubSourceLink(date: Date): string {
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const month = date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `https://crosswordclub.com/puzzles/${weekday}-${month}-${day}-${year}`;
}

async function fetchCrosswordClubPuzzle(
  date: Date,
  options: {
    publicationId: PublicationId;
    sourceLink: string;
  },
): Promise<ScrapedPuzzle> {
  const pageUrl = buildCrosswordClubSourceLink(date);

  const response = await fetch(pageUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Unable to load ${pageUrl}`);
  }

  const pageHtml = await response.text();
  const root = parse(pageHtml);
  const iframe = root.querySelector('iframe[src*="amuselabs.com/pardon/"]');
  const iframeUrl = iframe?.getAttribute('src');
  if (!iframeUrl) {
    throw new Error(`Cannot find puzzle at ${pageUrl}.`);
  }

  const puzzleId = new URL(iframeUrl, pageUrl).searchParams.get('id');
  if (!puzzleId) {
    throw new Error(`Cannot find puzzle id at ${pageUrl}.`);
  }

  const solverUrl = `https://cdn2.amuselabs.com/pmm/crossword?id=${puzzleId}&set=pardon-crossword`;
  return fetchAmuseLabsPuzzle(solverUrl, {
    publicationId: options.publicationId,
    date,
    sourceLink: options.sourceLink,
  });
}

export class CrosswordClubSource implements PuzzleSource {
  public id = 'CrosswordClub';
  public name = 'Crossword Club';

  public getPuzzle(date: Date) {
    return fetchCrosswordClubPuzzle(date, {
      publicationId: this.id as PublicationId,
      sourceLink: buildCrosswordClubSourceLink(date),
    });
  }
}
