import { decode } from 'html-entities';
import { PublicationId, PuzzleEntry, ScrapedPuzzle, Square } from 'cruzi-models';
import { formatDateKey } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

const USER_AGENT = 'cruzi-aws-crossword-scraper';
const DATA_BUCKET_URL = 'https://puzzlesdata.telegraph.co.uk';
const BUNDLE_URL = `${DATA_BUCKET_URL}/bundles/web/web.json`;
const VARIANT_SLUG = 'cross-atlantic';

interface TelegraphClue {
  number: number;
  clue: string;
  answer: string;
}

interface TelegraphClueSet {
  title: string;
  clues: TelegraphClue[];
}

interface TelegraphCopy {
  title: string;
  setter?: string;
  byline?: string;
  'date-publish-analytics'?: string;
  'date-epoch'?: number;
  gridsize: {
    cols: string;
    rows: string;
  };
  settings: {
    solution: string;
  };
  clues: TelegraphClueSet[];
}

interface TelegraphPuzzleJson {
  json: {
    copy: TelegraphCopy;
    meta?: {
      id?: string;
      slug?: string;
      author?: string;
    };
  };
}

interface TelegraphBundle {
  calendar: Record<string, Record<string, Record<string, string | null>>>;
}

function buildGameplayUrl(slug: string): string {
  const params = new URLSearchParams({
    id: slug,
    variant: VARIANT_SLUG,
    source: VARIANT_SLUG,
  });
  return `https://www.telegraph.co.uk/puzzles/gameplay/crossword/?${params.toString()}`;
}

function buildMonthKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function buildDayKey(date: Date): string {
  return String(date.getDate());
}

function normalizeClueText(clue: string): string {
  return decode(clue.replace(/<[^>]+>/g, '')).trim();
}

function parseTelegraphDate(copy: TelegraphCopy): Date {
  const analytics = copy['date-publish-analytics'];
  const match = analytics?.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  if (copy['date-epoch']) {
    const published = new Date(copy['date-epoch'] * 1000);
    return new Date(
      published.getUTCFullYear(),
      published.getUTCMonth(),
      published.getUTCDate(),
    );
  }

  throw new Error('Cannot parse Telegraph puzzle date.');
}

function findLatestSlug(calendar: Record<string, Record<string, string | null>>): string | null {
  let latestSlug: string | null = null;
  let latestTime = 0;

  for (const monthKey of Object.keys(calendar).sort()) {
    const [year, month] = monthKey.split('-').map(Number);
    const monthCalendar = calendar[monthKey];
    if (!monthCalendar) {
      continue;
    }

    for (const [dayKey, slug] of Object.entries(monthCalendar)) {
      if (!slug) {
        continue;
      }

      const puzzleTime = new Date(year, month - 1, Number(dayKey)).getTime();
      if (puzzleTime > latestTime) {
        latestTime = puzzleTime;
        latestSlug = slug;
      }
    }
  }

  return latestSlug;
}

function findSlugForDate(
  calendar: Record<string, Record<string, string | null>>,
  date: Date,
): string | null {
  const monthCalendar = calendar[buildMonthKey(date)];
  if (!monthCalendar) {
    return null;
  }

  return monthCalendar[buildDayKey(date)] ?? null;
}

function buildGridFromSolution(
  solution: string,
  width: number,
  height: number,
): Square[][] {
  const grid: Square[][] = [];

  for (let row = 0; row < height; row += 1) {
    const rowSquares: Square[] = [];
    for (let col = 0; col < width; col += 1) {
      const char = solution[row * width + col] ?? ' ';
      const isBlack = char === ' ';
      rowSquares.push({
        row,
        col,
        directions: [],
        isBlack,
        content: isBlack ? '' : char.toUpperCase(),
        isCircled: false,
      });
    }
    grid.push(rowSquares);
  }

  let currentNumber = 1;
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const square = grid[row][col];
      if (square.isBlack) {
        continue;
      }

      const needsAcrossNumber = col === 0 || grid[row][col - 1].isBlack;
      const needsDownNumber = row === 0 || grid[row - 1][col].isBlack;

      if (needsAcrossNumber || needsDownNumber) {
        square.number = currentNumber;
        currentNumber += 1;
        if (needsAcrossNumber) {
          square.directions.push('across');
        }
        if (needsDownNumber) {
          square.directions.push('down');
        }
      }
    }
  }

  return grid;
}

function buildEntriesFromClues(
  grid: Square[][],
  clues: TelegraphClueSet[],
): Map<string, PuzzleEntry> {
  const entries = new Map<string, PuzzleEntry>();
  const height = grid.length;
  const width = grid[0]?.length ?? 0;

  for (const clueSet of clues) {
    const direction = clueSet.title.toLowerCase().includes('down') ? 'D' : 'A';

    for (const clue of clueSet.clues) {
      const index = `${clue.number}${direction}`;
      const startSquare = grid.flat().find((square) => square.number === clue.number);
      let entry = clue.answer.toUpperCase();

      if (startSquare) {
        if (direction === 'A') {
          entry = '';
          for (let col = startSquare.col; col < width && !grid[startSquare.row][col].isBlack; col += 1) {
            entry += grid[startSquare.row][col].content;
          }
        } else {
          entry = '';
          for (let row = startSquare.row; row < height && !grid[row][startSquare.col].isBlack; row += 1) {
            entry += grid[row][startSquare.col].content;
          }
        }
      }

      entries.set(index, {
        index,
        entry,
        clue: normalizeClueText(clue.clue),
      });
    }
  }

  return entries;
}

function parseTelegraphPuzzle(
  payload: TelegraphPuzzleJson,
  options: {
    publicationId: PublicationId;
    sourceLink: string;
  },
): ScrapedPuzzle {
  const copy = payload.json.copy;
  const width = Number.parseInt(copy.gridsize.cols, 10);
  const height = Number.parseInt(copy.gridsize.rows, 10);
  const solution = copy.settings.solution;

  if (solution.length !== width * height) {
    throw new Error(
      `Telegraph puzzle solution length ${solution.length} does not match ${width}x${height} grid.`,
    );
  }

  const grid = buildGridFromSolution(solution, width, height);
  const entries = buildEntriesFromClues(grid, copy.clues);
  const author = copy.setter || copy.byline || payload.json.meta?.author;

  return {
    title: copy.title,
    publicationId: options.publicationId,
    date: parseTelegraphDate(copy),
    width,
    height,
    authors: author ? [author] : undefined,
    copyright: 'Telegraph Media Group',
    lang: 'en',
    sourceLink: options.sourceLink,
    grid,
    entries,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Telegraph data (${response.status}): ${url}`);
  }
  return response.json() as Promise<T>;
}

async function fetchTelegraphPuzzle(
  date: Date,
  publicationId: PublicationId,
): Promise<ScrapedPuzzle | null> {
  const bundle = await fetchJson<TelegraphBundle>(BUNDLE_URL);
  const calendar = bundle.calendar[VARIANT_SLUG];
  if (!calendar) {
    throw new Error(`Telegraph calendar missing variant ${VARIANT_SLUG}.`);
  }

  const slug = findSlugForDate(calendar, date) ?? findLatestSlug(calendar);
  if (!slug) {
    return null;
  }

  const puzzleUrl = `${DATA_BUCKET_URL}/puzzles/${VARIANT_SLUG}/${slug}.json`;
  const payload = await fetchJson<TelegraphPuzzleJson>(puzzleUrl);
  const puzzle = parseTelegraphPuzzle(payload, {
    publicationId,
    sourceLink: buildGameplayUrl(slug),
  });

  if (formatDateKey(puzzle.date) !== formatDateKey(date)) {
    console.log(
      `Telegraph Cross Atlantic puzzle for ${formatDateKey(date)} not in calendar; using ${formatDateKey(puzzle.date)} (${slug}).`,
    );
  }

  return puzzle;
}

export class TelegraphSource implements PuzzleSource {
  public id = 'Telegraph';
  public name = 'Telegraph Cross Atlantic';

  public getPuzzle(date: Date) {
    return fetchTelegraphPuzzle(date, this.id as PublicationId);
  }
}
