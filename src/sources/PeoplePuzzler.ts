import { PublicationId } from 'cruzi-models';
import { parse } from 'node-html-parser';
import puppeteer from 'puppeteer';
import { fetchAmuseLabsPuzzle, findAmuseLabsEmbedUrl } from '../lib/amuseLabs';
import { formatDateKey } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

const PEOPLE_PUZZLER_INDEX_URL = 'https://people.com/people-puzzler-8620185';
const USER_AGENT = 'cruzi-aws-crossword-scraper';
const PUZZLE_LINK_RE = /people-puzzler-crossword-([a-z]+)-(\d+)-(\d{4})/i;

const MONTH_ALIASES: Record<string, string> = {
  februrary: 'february',
};

function normalizeMonth(month: string): string {
  return MONTH_ALIASES[month.toLowerCase()] ?? month.toLowerCase();
}

function parsePeoplePuzzlerDateFromUrl(url: string): Date | null {
  const match = PUZZLE_LINK_RE.exec(url);
  if (!match) {
    return null;
  }

  const month = normalizeMonth(match[1]);
  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const monthIndex = new Date(`${month} 1, 2000`).getMonth();
  if (Number.isNaN(monthIndex)) {
    return null;
  }

  return new Date(year, monthIndex, day);
}

function findPuzzlePageUrlForDate(indexHtml: string, date: Date): string | null {
  const root = parse(indexHtml);
  const targetKey = formatDateKey(date);

  for (const anchor of root.querySelectorAll('a[href*="people-puzzler-crossword-"]')) {
    const href = anchor.getAttribute('href');
    if (!href) {
      continue;
    }

    const puzzleDate = parsePeoplePuzzlerDateFromUrl(href);
    if (puzzleDate && formatDateKey(puzzleDate) === targetKey) {
      return new URL(href, PEOPLE_PUZZLER_INDEX_URL).toString();
    }
  }

  return null;
}

async function fetchPeoplePageHtml(url: string): Promise<string> {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return await page.content();
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export class PeoplePuzzlerSource implements PuzzleSource {
  public id = 'PeoplePuzzler';
  public name = 'People Puzzler';

  public async getPuzzle(date: Date) {
    const indexHtml = await fetchPeoplePageHtml(PEOPLE_PUZZLER_INDEX_URL);
    const puzzlePageUrl = findPuzzlePageUrlForDate(indexHtml, date);
    if (!puzzlePageUrl) {
      return null;
    }

    const puzzleHtml = await fetchPeoplePageHtml(puzzlePageUrl);
    const solverUrl = findAmuseLabsEmbedUrl(puzzleHtml, puzzlePageUrl);
    if (!solverUrl) {
      throw new Error(`Can't find AmuseLabs embed on ${puzzlePageUrl}`);
    }

    return fetchAmuseLabsPuzzle(solverUrl, {
      publicationId: this.id as PublicationId,
      date,
      sourceLink: puzzlePageUrl,
    });
  }
}
