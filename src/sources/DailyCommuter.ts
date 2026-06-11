import { PuzzleEntry, PublicationId, ScrapedPuzzle, Square } from 'cruzi-models';
import { PuzzleSource } from '../scraper/PuzzleSource';

const API_KEY = '6f3eb88f19ae55f43278da1b128067c8c6eebbf0415d68237ed32a722143db4d';
const PRODUCT_ID = 'xwrddailycom';
const API_BASE_URL = 'https://puzzles.tribunecontentagency.com/puzzles/pzzapi/puzzle.do';

interface TribuneClue {
  clueNo: number;
  clueType: 'across' | 'down';
  answer: string;
  text: string;
}

interface TribuneCell {
  cellNumber: string;
  cellChar: string;
  cellType: string;
}

interface TribunePuzzleData {
  gridRow: number;
  gridCol: number;
  gCells: TribuneCell[];
  clues: TribuneClue[];
}

interface TribunePuzzleResponse {
  errorCode?: string;
  metaData?: {
    title?: string;
    author?: string;
    instructionSecondary?: string;
  };
  data?: TribunePuzzleData;
}

function formatPubDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function buildPuzzleUrl(date: Date): string {
  const params = new URLSearchParams({
    apiKey: API_KEY,
    productId: PRODUCT_ID,
    pubDate: formatPubDate(date),
  });
  return `${API_BASE_URL}?${params.toString()}`;
}

function buildGrid(data: TribunePuzzleData): Square[][] {
  const width = data.gridCol;
  const height = data.gridRow;
  const grid: Square[][] = [];

  for (let row = 0; row < height; row++) {
    const rowSquares: Square[] = [];

    for (let col = 0; col < width; col++) {
      const cell = data.gCells[row * width + col];
      const isBlack = cell.cellType === 'disable';
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
        if (directions.length > 0 && cell.cellNumber) {
          number = parseInt(cell.cellNumber, 10);
        }
      }

      rowSquares.push({
        row,
        col,
        number,
        directions,
        isBlack,
        content: isBlack ? '' : cell.cellChar,
        isCircled: false,
      });
    }

    grid.push(rowSquares);
  }

  return grid;
}

function buildEntries(clues: TribuneClue[]): Map<string, PuzzleEntry> {
  const entries = new Map<string, PuzzleEntry>();

  for (const clue of clues) {
    const direction = clue.clueType === 'across' ? 'A' : 'D';
    const index = `${clue.clueNo}${direction}`;
    entries.set(index, {
      index,
      clue: clue.text,
      entry: clue.answer.toUpperCase(),
    });
  }

  return entries;
}

export class DailyCommuterSource implements PuzzleSource {
  public id = 'DailyCommuter';
  public name = 'Daily Commuter';

  public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
    const url = buildPuzzleUrl(date);
    const response = await fetch(url);
    const payload = await response.json() as TribunePuzzleResponse;

    if (!response.ok) {
      if (payload.errorCode) {
        return null;
      }
      throw new Error(`Failed to fetch Daily Commuter puzzle (${response.status}).`);
    }

    if (payload.errorCode || !payload.data?.gCells?.length || !payload.data.clues?.length) {
      return null;
    }

    const { data, metaData } = payload;
    const puzzleDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const author = metaData?.author?.trim();

    return {
      publicationId: this.id as PublicationId,
      title: metaData?.title?.trim() || 'Daily Commuter Crossword',
      authors: author ? [author] : undefined,
      copyright: metaData?.instructionSecondary?.trim(),
      date: puzzleDate,
      sourceLink: url,
      width: data.gridCol,
      height: data.gridRow,
      grid: buildGrid(data),
      entries: buildEntries(data.clues),
      lang: 'en',
    };
  }
}
