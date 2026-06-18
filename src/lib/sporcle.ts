import { PublicationId, PuzzleEntry, ScrapedPuzzle } from 'cruzi-models';
import { newPuzzle, numberizeGrid } from './puzzle';
import { getMostRecentSunday, getPuzzleDate, toCalendarDate } from './utils';

const USER_AGENT = 'cruzi-aws-crossword-scraper';
const SPORCLE_BASE = 'https://www.sporcle.com';
const PLAYLIST_URL = `${SPORCLE_BASE}/playlists/SporcleEXP/sunday-crossword-ii`;

interface SporclePlaylistGame {
  name: string;
  url: string;
  order?: number;
  released?: number;
  offline?: number;
}

interface SporclePlaylistData {
  games: SporclePlaylistGame[];
}

interface SporcleCell {
  x: number;
  y: number;
  text: string;
  options?: { bg_color?: string };
}

interface SporcleHint {
  id: number;
  group_id: number;
  text: string;
}

interface SporcleGridPayload {
  colCount: number;
  rowCount: number;
  allCells: Record<string, SporcleCell>;
  allHints: Record<string, SporcleHint>;
  hintToCell: Record<string, string[]>;
}

function extractJsonObjectAfterMarker(html: string, marker: string): unknown {
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error(`Sporcle marker not found: ${marker}`);
  }

  let index = start + marker.length;
  while (html[index] === ' ' || html[index] === '\n' || html[index] === '\r' || html[index] === '\t') {
    index += 1;
  }

  if (html[index] !== '{') {
    throw new Error(`Expected JSON object after: ${marker}`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = index; i < html.length; i += 1) {
    const char = html[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(html.slice(index, i + 1));
      }
    }
  }

  throw new Error(`Unterminated JSON after: ${marker}`);
}

function extractVarString(html: string, varName: string): string | null {
  const match = html.match(new RegExp(`var ${varName}\\s*=\\s*['"]([^'"]*)['"]`));
  return match?.[1] ?? null;
}

async function fetchSporcleHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Sporcle page (${response.status}): ${url}`);
  }

  return response.text();
}

export function parsePlaylistLatestGameUrl(html: string): string {
  const playlistData = extractJsonObjectAfterMarker(
    html,
    'app.payload.playlistData = ',
  ) as SporclePlaylistData;

  const games = playlistData.games?.filter(
    (game) => game.url && game.released !== 0 && game.offline !== 1,
  ) ?? [];
  if (!games.length) {
    throw new Error('Sporcle playlist has no games.');
  }

  const latestGame = games.reduce((highestNumbered, game) => (
    (game.order ?? -1) > (highestNumbered.order ?? -1) ? game : highestNumbered
  ));
  if (!latestGame.url) {
    throw new Error('Sporcle playlist has no games.');
  }

  return `${SPORCLE_BASE}${latestGame.url}`;
}

function parseCellKey(key: string): { col: number; row: number } {
  const [col, row] = key.split(',').map(Number);
  return { col, row };
}

export function parseSporcleCrosswordHtml(
  html: string,
  options: {
    publicationId: PublicationId;
    date: Date;
    sourceLink: string;
  },
): ScrapedPuzzle {
  const payload = extractJsonObjectAfterMarker(
    html,
    'var payload = window._payload = ',
  ) as SporcleGridPayload;

  const title = extractVarString(html, 'gameNameDesc')
    ?? extractVarString(html, 'gti')
    ?? 'Sporcle Sunday Crossword';
  const creatorHandle = extractVarString(html, 'creatorHandle');
  const puzzleDate = toCalendarDate(options.date);

  const width = payload.colCount;
  const height = payload.rowCount;
  const puzzle = newPuzzle(width, height);

  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      puzzle.grid[row][col].isBlack = true;
    }
  }

  for (const cell of Object.values(payload.allCells)) {
    const square = puzzle.grid[cell.y][cell.x];
    square.isBlack = false;
    square.content = cell.text.toUpperCase();
    square.isCircled = Boolean(cell.options?.bg_color);
  }

  numberizeGrid(puzzle.grid);

  const entries = new Map<string, PuzzleEntry>();
  const hints = Object.values(payload.allHints).sort((a, b) => a.id - b.id);

  for (const hint of hints) {
    const cellKeys = payload.hintToCell[String(hint.id)];
    if (!cellKeys?.length) {
      continue;
    }

    const start = parseCellKey(cellKeys[0]);
    const startSquare = puzzle.grid[start.row][start.col];
    if (!startSquare.number) {
      continue;
    }

    const direction = hint.group_id === 0 ? 'A' : 'D';
    const index = `${startSquare.number}${direction}`;
    const entry = cellKeys
      .map((key) => {
        const { col, row } = parseCellKey(key);
        return puzzle.grid[row][col].content;
      })
      .join('');

    entries.set(index, {
      index,
      clue: hint.text,
      entry,
    });
  }

  puzzle.publicationId = options.publicationId;
  puzzle.title = title;
  puzzle.authors = creatorHandle ? [creatorHandle] : undefined;
  puzzle.date = puzzleDate;
  puzzle.sourceLink = options.sourceLink;
  puzzle.entries = entries;
  puzzle.lang = 'en';
  puzzle.copyright = 'Sporcle';

  return puzzle;
}

export async function fetchSporcleSundayPuzzle(
  options: {
    publicationId: PublicationId;
  },
): Promise<ScrapedPuzzle> {
  const puzzleDate = getMostRecentSunday(getPuzzleDate());
  const playlistHtml = await fetchSporcleHtml(PLAYLIST_URL);
  const crosswordUrl = parsePlaylistLatestGameUrl(playlistHtml);
  const crosswordHtml = await fetchSporcleHtml(crosswordUrl);

  return parseSporcleCrosswordHtml(crosswordHtml, {
    publicationId: options.publicationId,
    date: puzzleDate,
    sourceLink: crosswordUrl,
  });
}
