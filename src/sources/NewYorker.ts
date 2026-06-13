import { parse } from 'node-html-parser';
import { PublicationId, ScrapedPuzzle } from 'cruzi-models';
import { parseXdFormat } from '../lib/xdFormat';
import { formatDateKey, toCalendarDate } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

const API_ENDPOINT = 'https://puzzles-games-api.gp-prod.conde.digital/api/v1/games/';
const USER_AGENT = 'cruzi-aws-crossword-scraper';

function buildCrosswordPageUrl(date: Date, mini: boolean): string {
  const path = mini ? 'mini-crossword' : 'crossword';
  const datePart = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  return `https://www.newyorker.com/puzzles-and-games-dept/${path}/${datePart}`;
}

async function fetchNewYorkerXdData(
  date: Date,
  mini: boolean,
): Promise<{
  xdData: string;
  themeTitle: string;
  puzzleDate: Date;
  sourceLink: string;
} | null> {
  const pageUrl = buildCrosswordPageUrl(date, mini);
  const response = await fetch(pageUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    const puzzleType = mini ? 'mini crossword' : 'crossword';
    console.log(
      `New Yorker: The ${puzzleType} for ${formatDateKey(date)} has not been posted yet.`,
    );
    return null;
  }

  const pageHtml = await response.text();
  const puzzleIdMatch = /"id":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/.exec(pageHtml);
  if (!puzzleIdMatch) {
    throw new Error(`Puzzle ID not found on ${pageUrl}`);
  }

  const root = parse(pageHtml);
  let themeTitle = '';
  const description = root.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? '';
  const themePrefix = 'Today\u2019s theme: ';
  if (description.startsWith(themePrefix)) {
    themeTitle = description.slice(themePrefix.length).replace(/\.$/, '');
  }

  const puzzleDate = toCalendarDate(date);

  const apiUrl = `${API_ENDPOINT}${puzzleIdMatch[1]}`;
  const apiResponse = await fetch(apiUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (apiResponse.status === 403) {
    throw new Error(
      'Received a 403 response when attempting to download New Yorker puzzle data.',
    );
  }

  if (!apiResponse.ok) {
    throw new Error(`Error while downloading New Yorker puzzle data (${apiResponse.status}).`);
  }

  const apiPayload = await apiResponse.json() as { data?: string };
  if (!apiPayload.data) {
    throw new Error('New Yorker puzzle data missing from API response.');
  }

  return {
    xdData: apiPayload.data,
    themeTitle,
    puzzleDate,
    sourceLink: pageUrl,
  };
}

function finalizeNewYorkerTitle(title: string, themeTitle: string, boilerplate: string): string {
  let resolvedTitle = title;
  if (resolvedTitle.includes('<')) {
    resolvedTitle = resolvedTitle.split('<')[0];
  }

  if (themeTitle) {
    resolvedTitle = `${resolvedTitle} - ${themeTitle}`;
  }

  try {
    const [supra, main] = resolvedTitle.split(':', 2);
    if (themeTitle && main.includes(' - ')) {
      const trimmedMain = main.split(' - ')[0]?.trim();
      if (supra.trim() === boilerplate && trimmedMain && !Number.isNaN(Date.parse(trimmedMain))) {
        return themeTitle;
      }
    }
    if (supra.trim() === boilerplate && main.trim()) {
      return themeTitle || main.trim();
    }
  } catch {
    // keep resolved title
  }

  return resolvedTitle.trim();
}

async function fetchNewYorkerPuzzle(
  date: Date,
  publicationId: PublicationId,
): Promise<ScrapedPuzzle | null> {
  if (date.getDay() === 0 || date.getDay() === 6) {
    return null;
  }

  const mini = ![1, 2, 3].includes(date.getDay());
  const xdDataResult = await fetchNewYorkerXdData(date, mini);
  if (!xdDataResult) {
    return null;
  }

  const { xdData, themeTitle, puzzleDate, sourceLink } = xdDataResult;
  const boilerplate = mini ? 'The Mini Crossword' : 'The Crossword';

  const puzzle = parseXdFormat(xdData, {
    publicationId,
    date: puzzleDate,
    sourceLink,
  });

  puzzle.title = finalizeNewYorkerTitle(puzzle.title, themeTitle, boilerplate);
  puzzle.date = toCalendarDate(date);

  return puzzle;
}

export class NewYorkerSource implements PuzzleSource {
  public id = 'NewYorker';
  public name = 'New Yorker';

  public getPuzzle(date: Date) {
    return fetchNewYorkerPuzzle(date, this.id as PublicationId);
  }
}
