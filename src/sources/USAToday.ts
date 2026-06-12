import { parse } from 'node-html-parser';
import { PublicationId, PuzzleEntry, ScrapedPuzzle, Square } from 'cruzi-models';
import { formatDateKey2 } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildGridFromSolution(
  solution: string,
  width: number,
  height: number,
): { grid: Square[][]; entries: Map<string, PuzzleEntry> } {
  const grid: Square[][] = [];
  let index = 0;

  for (let row = 0; row < height; row += 1) {
    const rowSquares: Square[] = [];
    for (let col = 0; col < width; col += 1) {
      const char = solution[index] ?? '.';
      index += 1;
      const isBlack = char === '.';
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

  const entries = new Map<string, PuzzleEntry>();
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const square = grid[row][col];
      if (!square.number) {
        continue;
      }

      if (square.directions.includes('across')) {
        let entry = '';
        for (let c = col; c < width && !grid[row][c].isBlack; c += 1) {
          entry += grid[row][c].content;
        }
        entries.set(`${square.number}A`, {
          index: `${square.number}A`,
          entry,
          clue: '',
        });
      }

      if (square.directions.includes('down')) {
        let entry = '';
        for (let r = row; r < height && !grid[r][col].isBlack; r += 1) {
          entry += grid[r][col].content;
        }
        entries.set(`${square.number}D`, {
          index: `${square.number}D`,
          entry,
          clue: '',
        });
      }
    }
  }

  return { grid, entries };
}

function parseUsaTodayXml(
  xml: string,
  options: {
    publicationId: PublicationId;
    date: Date;
    sourceLink: string;
  },
): ScrapedPuzzle {
  const root = parse(xml, { lowerCaseTagName: true });
  const crossword = root.querySelector('crossword');
  if (!crossword) {
    throw new Error('USA Today puzzle data malformed, cannot parse.');
  }

  const getValue = (tagName: string): string => {
    const node = crossword.querySelector(tagName);
    return decodeURIComponentSafe(node?.getAttribute('v') ?? '').trim();
  };

  const width = Number.parseInt(getValue('width'), 10);
  const height = Number.parseInt(getValue('height'), 10);
  const solution = getValue('allanswer').replace(/-/g, '.');
  const { grid, entries } = buildGridFromSolution(solution, width, height);

  const acrossNodes = crossword.querySelector('across')?.querySelectorAll('*') ?? [];
  const downNodes = crossword.querySelector('down')?.querySelectorAll('*') ?? [];
  const clueNodes = [...acrossNodes, ...downNodes]
    .map((node) => ({
      number: Number.parseInt(node.getAttribute('cn') ?? '', 10),
      clue: decodeURIComponentSafe(node.getAttribute('c') ?? '').trim(),
    }))
    .sort((a, b) => a.number - b.number);

  for (const clueNode of clueNodes) {
    const acrossEntry = entries.get(`${clueNode.number}A`);
    if (acrossEntry && !acrossEntry.clue) {
      acrossEntry.clue = clueNode.clue;
      continue;
    }
    const downEntry = entries.get(`${clueNode.number}D`);
    if (downEntry && !downEntry.clue) {
      downEntry.clue = clueNode.clue;
    }
  }

  const puzzleDate = new Date(
    options.date.getFullYear(),
    options.date.getMonth(),
    options.date.getDate(),
  );

  return {
    publicationId: options.publicationId,
    title: getValue('title'),
    authors: getValue('author') ? [getValue('author')] : undefined,
    copyright: getValue('copyright') || undefined,
    date: puzzleDate,
    sourceLink: options.sourceLink,
    width,
    height,
    grid,
    entries,
    lang: 'en',
  };
}

function buildUsaTodaySourceLink(date: Date): string {
  return `http://picayune.uclick.com/comics/usaon/data/usaon${formatDateKey2(date)}-data.xml`;
}

async function fetchUsaTodayPuzzle(
  date: Date,
  publicationId: PublicationId,
): Promise<ScrapedPuzzle | null> {
  const sourceLink = buildUsaTodaySourceLink(date);
  const headResponse = await fetch(sourceLink, { method: 'HEAD' });
  if (!headResponse.ok) {
    return null;
  }

  const response = await fetch(sourceLink);
  if (!response.ok) {
    return null;
  }

  return parseUsaTodayXml(await response.text(), {
    publicationId,
    date,
    sourceLink,
  });
}

export class USATodaySource implements PuzzleSource {
  public id = 'USAToday';
  public name = 'USA Today';

  public getPuzzle(date: Date) {
    return fetchUsaTodayPuzzle(date, this.id as PublicationId);
  }
}
