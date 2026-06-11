import { PuzzleEntry, PublicationId, ScrapedPuzzle, Square } from 'cruzi-models';

const PUZZLE_BASE_URL = 'https://puzzles.kingfeatures.com/data/puzzles';

interface KingFeaturesWord {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  length: number;
}

interface KingFeaturesClue {
  word: KingFeaturesWord;
  number: number;
  text: string;
}

interface KingFeaturesCell {
  x: number;
  y: number;
  solution?: string;
  number?: number;
  type?: string;
}

interface KingFeaturesPuzzleResponse {
  content?: {
    meta?: {
      title?: string;
      creator?: string;
      copyright?: string;
    };
    grid?: {
      cells: KingFeaturesCell[];
      width: number;
      height: number;
    };
    clues?: {
      across: KingFeaturesClue[];
      down: KingFeaturesClue[];
    };
  };
}

function formatPuzzleDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function buildKingFeaturesPuzzleUrl(slug: string, date: Date): string {
  return `${PUZZLE_BASE_URL}/${slug}/${formatPuzzleDateKey(date)}.json`;
}

function getAnswerForWord(
  word: KingFeaturesWord,
  cellsByPosition: Map<string, KingFeaturesCell>,
): string {
  const letters: string[] = [];

  if (word.y1 === word.y2) {
    for (let x = word.x1; x <= word.x2; x++) {
      letters.push(cellsByPosition.get(`${x},${word.y1}`)?.solution ?? '');
    }
  } else {
    for (let y = word.y1; y <= word.y2; y++) {
      letters.push(cellsByPosition.get(`${word.x1},${y}`)?.solution ?? '');
    }
  }

  return letters.join('').toUpperCase();
}

function buildGrid(
  width: number,
  height: number,
  cellsByPosition: Map<string, KingFeaturesCell>,
): Square[][] {
  const grid: Square[][] = [];

  for (let row = 0; row < height; row++) {
    const rowSquares: Square[] = [];

    for (let col = 0; col < width; col++) {
      const cell = cellsByPosition.get(`${col + 1},${row + 1}`);
      const isBlack = !cell || cell.type === 'block';
      const directions: string[] = [];
      let number: number | undefined;

      if (!isBlack) {
        const needsAcrossNumber = col === 0 || rowSquares[col - 1]?.isBlack;
        const needsDownNumber = row === 0 || grid[row - 1]?.[col]?.isBlack;

        if (needsAcrossNumber) {
          directions.push('across');
        }
        if (needsDownNumber) {
          directions.push('down');
        }
        if (directions.length > 0 && cell?.number) {
          number = cell.number;
        }
      }

      rowSquares.push({
        row,
        col,
        number,
        directions,
        isBlack,
        content: isBlack ? '' : (cell?.solution ?? '').toUpperCase(),
        isCircled: false,
      });
    }

    grid.push(rowSquares);
  }

  return grid;
}

function buildEntries(
  acrossClues: KingFeaturesClue[],
  downClues: KingFeaturesClue[],
  cellsByPosition: Map<string, KingFeaturesCell>,
): Map<string, PuzzleEntry> {
  const entries = new Map<string, PuzzleEntry>();

  for (const clue of acrossClues) {
    entries.set(`${clue.number}A`, {
      index: `${clue.number}A`,
      clue: clue.text,
      entry: getAnswerForWord(clue.word, cellsByPosition),
    });
  }

  for (const clue of downClues) {
    entries.set(`${clue.number}D`, {
      index: `${clue.number}D`,
      clue: clue.text,
      entry: getAnswerForWord(clue.word, cellsByPosition),
    });
  }

  return entries;
}

function parseKingFeaturesPuzzle(
  payload: KingFeaturesPuzzleResponse,
  options: {
    publicationId: PublicationId;
    date: Date;
    sourceLink: string;
    defaultTitle: string;
  },
): ScrapedPuzzle | null {
  const gridData = payload.content?.grid;
  const clues = payload.content?.clues;
  const meta = payload.content?.meta;

  if (!gridData?.cells?.length || !clues?.across?.length || !clues.down?.length) {
    return null;
  }

  const { width, height } = gridData;
  if (!width || !height) {
    return null;
  }

  const cellsByPosition = new Map<string, KingFeaturesCell>();
  for (const cell of gridData.cells) {
    cellsByPosition.set(`${cell.x},${cell.y}`, cell);
  }

  const puzzleDate = new Date(
    options.date.getFullYear(),
    options.date.getMonth(),
    options.date.getDate(),
  );

  return {
    publicationId: options.publicationId,
    title: meta?.title?.trim() || options.defaultTitle,
    authors: meta?.creator?.trim() ? [meta.creator.trim()] : undefined,
    copyright: meta?.copyright?.trim(),
    date: puzzleDate,
    sourceLink: options.sourceLink,
    width,
    height,
    grid: buildGrid(width, height, cellsByPosition),
    entries: buildEntries(clues.across, clues.down, cellsByPosition),
    lang: 'en',
  };
}

export async function fetchKingFeaturesPuzzle(
  slug: string,
  date: Date,
  options: {
    publicationId: PublicationId;
    defaultTitle: string;
    parseErrorMessage: string;
  },
): Promise<ScrapedPuzzle | null> {
  const url = buildKingFeaturesPuzzleUrl(slug, date);
  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as KingFeaturesPuzzleResponse;
  const puzzle = parseKingFeaturesPuzzle(payload, {
    publicationId: options.publicationId,
    date,
    sourceLink: url,
    defaultTitle: options.defaultTitle,
  });

  if (!puzzle) {
    throw new Error(options.parseErrorMessage);
  }

  return puzzle;
}
