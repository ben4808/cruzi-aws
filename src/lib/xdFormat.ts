import { PublicationId, PuzzleEntry, ScrapedPuzzle, Square } from 'cruzi-models';
import { toCalendarDate } from './utils';

interface ParsedClue {
  direction: 'A' | 'D';
  number: number;
  text: string;
}

function parseClueLine(line: string): ParsedClue | null {
  const match = /^([AD])(\d{1,2})\.(.*)/.exec(line.trim());
  if (!match) {
    return null;
  }

  let clueText = match[3];
  for (const sigil of ['/*-_~^']) {
    clueText = clueText.replace(new RegExp(`\\{${sigil}`, 'g'), sigil);
    clueText = clueText.replace(new RegExp(`${sigil}\\}`, 'g'), sigil);
  }

  return {
    direction: match[1] as 'A' | 'D',
    number: Number.parseInt(match[2], 10),
    text: clueText.split(' ~ ')[0].trim(),
  };
}

export function parseXdFormat(
  xdData: string,
  options: {
    publicationId: PublicationId;
    date: Date;
    sourceLink: string;
    title?: string;
    author?: string;
    copyright?: string;
  },
): ScrapedPuzzle {
  const puzzleLines = xdData.split('\n').map((line) => line.trim());
  const defaultSections = ['metadata', 'grid', 'clues', 'notes'];

  let section: string | null = null;
  let blankCount = 2;
  let namedSections = false;
  let observedHeight = 0;
  let observedWidth = 0;
  const clueList: ParsedClue[] = [];
  const rebusEntries: Record<string, string> = {};

  let title = options.title ?? '';
  let author = options.author ?? '';
  let copyright = options.copyright ?? '';
  let notes: string | undefined;
  const gridLines: string[] = [];

  for (const line of puzzleLines) {
    if (!line) {
      blankCount += 1;
      continue;
    }

    if (line.startsWith('## ')) {
      namedSections = true;
      section = line.slice(3).toLowerCase();
      blankCount = 0;
      continue;
    }

    if (!namedSections && blankCount >= 2) {
      section = defaultSections.shift() ?? null;
      blankCount = 0;
    } else {
      blankCount = 0;
    }

    if (section === 'metadata') {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        continue;
      }
      const key = line.slice(0, colonIndex).trim().toLowerCase();
      const value = line.slice(colonIndex + 1).trim();
      if (key === 'title') {
        title = value;
      } else if (key === 'author') {
        author = value;
      } else if (key === 'copyright') {
        copyright = value.replace(/^ ©/, '');
      } else if (key === 'rebus') {
        for (const entry of value.split(/\s+/)) {
          const [from, to] = entry.split('=');
          if (from && to) {
            rebusEntries[from] = to;
          }
        }
      }
      continue;
    }

    if (section === 'grid') {
      if (!observedWidth) {
        observedWidth = line.length;
      }
      observedHeight += 1;
      gridLines.push(line);
      continue;
    }

    if (section === 'clues') {
      const clue = parseClueLine(line);
      if (clue) {
        clueList.push(clue);
      }
      continue;
    }

    if (section === 'notes') {
      notes = notes ? `${notes}\n${line}` : line;
    }
  }

  const grid: Square[][] = [];
  for (let row = 0; row < observedHeight; row += 1) {
    const rowSquares: Square[] = [];
    const line = gridLines[row] ?? '';

    for (let col = 0; col < observedWidth; col += 1) {
      const char = line[col] ?? '.';
      const isBlack = !char || char === '.';
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
  for (let row = 0; row < observedHeight; row += 1) {
    for (let col = 0; col < observedWidth; col += 1) {
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
  clueList.sort((a, b) => a.number - b.number || a.direction.localeCompare(b.direction));

  for (const clue of clueList) {
    const index = `${clue.number}${clue.direction}`;
    let entry = '';

    const startSquare = grid.flat().find((square) => square.number === clue.number);
    if (startSquare) {
      if (clue.direction === 'A') {
        for (let col = startSquare.col; col < observedWidth && !grid[startSquare.row][col].isBlack; col += 1) {
          entry += grid[startSquare.row][col].content;
        }
      } else {
        for (let row = startSquare.row; row < observedHeight && !grid[row][startSquare.col].isBlack; row += 1) {
          entry += grid[row][startSquare.col].content;
        }
      }
    }

    entries.set(index, {
      index,
      clue: clue.text,
      entry,
    });
  }

  const puzzleDate = toCalendarDate(options.date);

  return {
    publicationId: options.publicationId,
    title,
    authors: author ? [author] : undefined,
    copyright: copyright || undefined,
    notes,
    date: puzzleDate,
    sourceLink: options.sourceLink,
    width: observedWidth,
    height: observedHeight,
    grid,
    entries,
    lang: 'en',
  };
}

export function parseLooseDate(text: string): Date | null {
  const direct = Date.parse(text);
  if (!Number.isNaN(direct)) {
    return new Date(direct);
  }

  const firstPart = text.split('-')[0]?.trim();
  if (firstPart) {
    const partial = Date.parse(firstPart);
    if (!Number.isNaN(partial)) {
      return new Date(partial);
    }
  }

  return null;
}
