import { parse } from 'node-html-parser';
import { PuzzleEntry, ScrapedPuzzle, Square } from 'cruzi-models';

interface CompilerCell {
  x: number;
  y: number;
  solution?: string;
  number?: number;
  isBlock: boolean;
  isCircled: boolean;
}

interface CompilerWord {
  id: number;
  x: string;
  y: string;
}

interface CompilerClue {
  wordId: number;
  number: number;
  text: string;
}

function parseRange(value: string): number[] {
  if (value.includes('-')) {
    const [start, end] = value.split('-').map((part) => parseInt(part, 10));
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }
  return [parseInt(value, 10)];
}

function getWordCells(word: CompilerWord): { x: number; y: number }[] {
  const xs = parseRange(word.x);
  const ys = parseRange(word.y);
  const cells: { x: number; y: number }[] = [];

  if (xs.length === 1) {
    for (const y of ys) {
      cells.push({ x: xs[0], y });
    }
  } else if (ys.length === 1) {
    for (const x of xs) {
      cells.push({ x, y: ys[0] });
    }
  }

  return cells;
}

function getAnswerForWord(
  word: CompilerWord,
  cellsByPosition: Map<string, CompilerCell>,
): string {
  return getWordCells(word)
    .map(({ x, y }) => cellsByPosition.get(`${x},${y}`)?.solution ?? '')
    .join('')
    .toUpperCase();
}

function buildGrid(
  width: number,
  height: number,
  cellsByPosition: Map<string, CompilerCell>,
): Square[][] {
  const grid: Square[][] = [];

  for (let row = 0; row < height; row++) {
    const rowSquares: Square[] = [];

    for (let col = 0; col < width; col++) {
      const cell = cellsByPosition.get(`${col + 1},${row + 1}`);
      const isBlack = !cell || cell.isBlock;
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
        content: isBlack ? '' : (cell?.solution ?? ''),
        isCircled: cell?.isCircled ?? false,
      });
    }

    grid.push(rowSquares);
  }

  return grid;
}

function buildEntries(
  acrossClues: CompilerClue[],
  downClues: CompilerClue[],
  wordsById: Map<number, CompilerWord>,
  cellsByPosition: Map<string, CompilerCell>,
): Map<string, PuzzleEntry> {
  const entries = new Map<string, PuzzleEntry>();

  for (const clue of acrossClues) {
    const word = wordsById.get(clue.wordId);
    if (!word) {
      continue;
    }

    entries.set(`${clue.number}A`, {
      index: `${clue.number}A`,
      clue: clue.text,
      entry: getAnswerForWord(word, cellsByPosition),
    });
  }

  for (const clue of downClues) {
    const word = wordsById.get(clue.wordId);
    if (!word) {
      continue;
    }

    entries.set(`${clue.number}D`, {
      index: `${clue.number}D`,
      clue: clue.text,
      entry: getAnswerForWord(word, cellsByPosition),
    });
  }

  return entries;
}

export function parseCrosswordCompilerXml(
  xml: string,
  options: {
    publicationId: ScrapedPuzzle['publicationId'];
    date: Date;
    sourceLink: string;
    defaultTitle: string;
  },
): ScrapedPuzzle | null {
  const root = parse(xml, { lowerCaseTagName: true });
  const puzzleNode = root.querySelector('rectangular-puzzle');
  const crosswordNode = puzzleNode?.querySelector('crossword');

  if (!puzzleNode || !crosswordNode) {
    return null;
  }

  const metadata = puzzleNode.querySelector('metadata');
  const gridNode = crosswordNode.querySelector('grid');
  const cellNodes = crosswordNode.querySelectorAll('cell');
  const wordNodes = crosswordNode.querySelectorAll('word');
  const clueSections = crosswordNode.querySelectorAll('clues');

  if (!gridNode || cellNodes.length === 0 || clueSections.length < 2) {
    return null;
  }

  const width = parseInt(gridNode.getAttribute('width') ?? '', 10);
  const height = parseInt(gridNode.getAttribute('height') ?? '', 10);

  if (!width || !height) {
    return null;
  }

  const cellsByPosition = new Map<string, CompilerCell>();

  for (const cellNode of cellNodes) {
    const x = parseInt(cellNode.getAttribute('x') ?? '', 10);
    const y = parseInt(cellNode.getAttribute('y') ?? '', 10);
    const numberAttr = cellNode.getAttribute('number');
    const isBlock = cellNode.getAttribute('type') === 'block';

    cellsByPosition.set(`${x},${y}`, {
      x,
      y,
      solution: cellNode.getAttribute('solution') ?? undefined,
      number: numberAttr ? parseInt(numberAttr, 10) : undefined,
      isBlock,
      isCircled: cellNode.getAttribute('background-shape') === 'circle',
    });
  }

  const wordsById = new Map<number, CompilerWord>();

  for (const wordNode of wordNodes) {
    const id = parseInt(wordNode.getAttribute('id') ?? '', 10);
    const x = wordNode.getAttribute('x');
    const y = wordNode.getAttribute('y');

    if (!id || !x || !y) {
      continue;
    }

    wordsById.set(id, { id, x, y });
  }

  const parseClues = (section: typeof clueSections[number]): CompilerClue[] =>
    section.querySelectorAll('clue').map((clueNode) => ({
      wordId: parseInt(clueNode.getAttribute('word') ?? '', 10),
      number: parseInt(clueNode.getAttribute('number') ?? '', 10),
      text: clueNode.text.trim(),
    }));

  const acrossClues = parseClues(clueSections[0]);
  const downClues = parseClues(clueSections[1]);

  if (!acrossClues.length || !downClues.length) {
    return null;
  }

  const title = metadata?.querySelector('title')?.text.trim();
  const creator = metadata?.querySelector('creator')?.text.trim();
  const copyright = metadata?.querySelector('copyright')?.text.trim();
  const notes = metadata?.querySelector('extended')?.text.trim();

  const puzzleDate = new Date(
    options.date.getFullYear(),
    options.date.getMonth(),
    options.date.getDate(),
  );

  return {
    publicationId: options.publicationId,
    title: title || options.defaultTitle,
    authors: creator ? [creator] : undefined,
    copyright,
    notes: notes || undefined,
    date: puzzleDate,
    sourceLink: options.sourceLink,
    width,
    height,
    grid: buildGrid(width, height, cellsByPosition),
    entries: buildEntries(acrossClues, downClues, wordsById, cellsByPosition),
    lang: 'en',
  };
}
