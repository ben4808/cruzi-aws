import { PublicationId, PuzzleEntry, ScrapedPuzzle } from 'cruzi-models';
import { parse } from 'node-html-parser';
import { stripAccents } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

const USER_AGENT = 'cruzi-aws-crossword-scraper';

interface CrosshareClue {
  dir: number;
  clue: string;
  num: number;
}

interface CrossharePuzzle {
  title: string;
  guestConstructor?: string;
  authorName?: string;
  size: { rows: number; cols: number };
  grid: string[];
  clues: CrosshareClue[];
}

function buildSlateArticleUrl(date: Date): string {
  const year = date.getFullYear();
  const monthPadded = String(date.getMonth() + 1).padStart(2, '0');
  const month = date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
  const day = date.getDate();
  return `https://slate.com/life/${year}/${monthPadded}/crossword-slate-daily-puzzle-${month}-${day}-${year}.html`;
}

function findCrosshareEmbedUrl(html: string): string | null {
  const root = parse(html);
  const embed = root.querySelector('[data-embed-url*="crosshare.org/embed/"]');
  const embedUrl = embed?.getAttribute('data-embed-url');
  return embedUrl || null;
}

async function fetchSlatePageHtml(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch Slate article (${response.status}): ${url}`);
  }
  return response.text();
}

function extractCrossharePuzzleFromHtml(html: string): CrossharePuzzle {
  const marker = '{"props":{"pageProps":{"puzzle":';
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error('Crosshare puzzle data not found in embed page.');
  }

  const jsonStart = html.lastIndexOf('<script', start);
  const scriptOpenEnd = html.indexOf('>', jsonStart) + 1;
  const scriptClose = html.indexOf('</script>', start);
  const data = JSON.parse(html.slice(scriptOpenEnd, scriptClose)) as {
    props: { pageProps: { puzzle: CrossharePuzzle } };
  };

  return data.props.pageProps.puzzle;
}

function parseCrossharePuzzle(
  puzzle: CrossharePuzzle,
  options: {
    publicationId: PublicationId;
    date: Date;
    sourceLink: string;
  },
): ScrapedPuzzle {
  const width = puzzle.size.cols;
  const height = puzzle.size.rows;
  const grid: ScrapedPuzzle['grid'] = [];

  for (let row = 0; row < height; row += 1) {
    const rowSquares: ScrapedPuzzle['grid'][number] = [];
    for (let col = 0; col < width; col += 1) {
      const cell = puzzle.grid[row * width + col] ?? '.';
      const isBlack = !cell || cell === '.';
      let content = '';
      if (!isBlack) {
        content = cell.length === 1
          ? cell.toUpperCase()
          : stripAccents(cell).toUpperCase();
      }

      rowSquares.push({
        row,
        col,
        directions: [],
        isBlack,
        content,
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

  const entries = new Map<string, PuzzleEntry>();
  const sortedClues = [...puzzle.clues].sort(
    (a, b) => a.num - b.num || a.dir - b.dir,
  );

  for (const clue of sortedClues) {
    const direction = clue.dir === 0 ? 'A' : 'D';
    const index = `${clue.num}${direction}`;
    const startSquare = grid.flat().find((square) => square.number === clue.num);
    let entry = '';

    if (startSquare) {
      if (direction === 'A') {
        for (let col = startSquare.col; col < width && !grid[startSquare.row][col].isBlack; col += 1) {
          entry += grid[startSquare.row][col].content;
        }
      } else {
        for (let row = startSquare.row; row < height && !grid[row][startSquare.col].isBlack; row += 1) {
          entry += grid[row][startSquare.col].content;
        }
      }
    }

    entries.set(index, {
      index,
      clue: clue.clue,
      entry,
    });
  }

  const author = puzzle.guestConstructor || puzzle.authorName;
  const puzzleDate = new Date(
    options.date.getFullYear(),
    options.date.getMonth(),
    options.date.getDate(),
  );

  return {
    publicationId: options.publicationId,
    title: puzzle.title,
    authors: author ? [author] : undefined,
    date: puzzleDate,
    sourceLink: options.sourceLink,
    width,
    height,
    grid,
    entries,
    lang: 'en',
  };
}

async function fetchCrossharePuzzle(
  embedUrl: string,
  options: {
    publicationId: PublicationId;
    date: Date;
    sourceLink: string;
  },
): Promise<ScrapedPuzzle> {
  const response = await fetch(embedUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      Referer: options.sourceLink,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Crosshare embed (${response.status}): ${embedUrl}`);
  }

  const html = await response.text();
  const puzzle = extractCrossharePuzzleFromHtml(html);
  return parseCrossharePuzzle(puzzle, options);
}

export class SlateSource implements PuzzleSource {
  public id = 'Slate';
  public name = 'Slate';

  public async getPuzzle(date: Date) {
    const articleUrl = buildSlateArticleUrl(date);
    const articleHtml = await fetchSlatePageHtml(articleUrl);
    if (!articleHtml) {
      return null;
    }

    const embedUrl = findCrosshareEmbedUrl(articleHtml);
    if (!embedUrl) {
      throw new Error(`Can't find Crosshare embed on ${articleUrl}`);
    }

    return fetchCrossharePuzzle(embedUrl, {
      publicationId: this.id as PublicationId,
      date,
      sourceLink: articleUrl,
    });
  }
}
