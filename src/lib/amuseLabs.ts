import { parse } from 'node-html-parser';
import { PublicationId, PuzzleEntry, ScrapedPuzzle, Square } from 'cruzi-models';
import { deobfuscateRawc } from './amuseLabsRawc';
import { formatDateKey, stripAccents } from './utils';

const USER_AGENT = 'cruzi-aws-crossword-scraper';

interface AmuseLabsWord {
  x: number;
  y: number;
  acrossNotDown: boolean;
  clue: { clue?: string };
}

interface AmuseLabsCellInfo {
  x: number;
  y: number;
  isCircled?: boolean;
}

interface AmuseLabsData {
  title?: string;
  author?: string;
  copyright?: string;
  w: number;
  h: number;
  publishTime?: number;
  cellInfos?: AmuseLabsCellInfo[];
  box: string[][];
  placedWords: AmuseLabsWord[];
}

export interface AmuseLabsOutletConfig {
  urlFromId: string;
  pickerUrl?: string;
  setName?: string;
}

function computeFvlt(setName: string, puzzleId: string, uid: string): string {
  const charsum = (value: string): number => {
    let total = 0;
    for (const char of value) {
      total = (total + char.charCodeAt(0)) >>> 0;
    }
    return total;
  };

  return ((charsum(setName) ^ charsum(puzzleId) ^ charsum(uid)) >>> 0).toString(16);
}

function extractCookieValue(setCookieHeader: string | null, name: string): string | undefined {
  if (!setCookieHeader) {
    return undefined;
  }

  const match = new RegExp(`${name}=([^;]+)`).exec(setCookieHeader);
  return match?.[1];
}

async function fetchText(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      'User-Agent': USER_AGENT,
      ...(init?.headers ?? {}),
    },
  });
}

interface AmuseLabsPickerParams {
  rawsps?: string;
  streakInfo?: Array<{
    puzzleDetails?: {
      puzzleId?: string;
      publicationTime?: number;
    };
  }>;
}

function parsePickerParams(pickerHtml: string): AmuseLabsPickerParams {
  const root = parse(pickerHtml);
  const paramTag = root.querySelector('script#params');
  return paramTag?.text ? JSON.parse(paramTag.text) : {};
}

function publicationTimeToDateKey(publicationTime: number): string {
  const published = new Date(publicationTime);
  return formatDateKey(new Date(
    published.getUTCFullYear(),
    published.getUTCMonth(),
    published.getUTCDate(),
  ));
}

function selectPuzzleIdFromPicker(pickerHtml: string, index = 0): string {
  const puzzles = parsePickerParams(pickerHtml).streakInfo ?? [];

  if (!puzzles.length) {
    throw new Error('Unable to find puzzles data from picker page.');
  }

  const puzzleId = puzzles[index]?.puzzleDetails?.puzzleId;
  if (!puzzleId) {
    throw new Error('Unexpected puzzle metadata format from AmuseLabs picker.');
  }

  return puzzleId;
}

function selectPuzzleIdFromPickerByDate(pickerHtml: string, date: Date): string | null {
  const targetDateKey = formatDateKey(date);
  const puzzles = parsePickerParams(pickerHtml).streakInfo ?? [];

  for (const puzzle of puzzles) {
    const details = puzzle.puzzleDetails;
    if (!details?.puzzleId || !details.publicationTime) {
      continue;
    }

    if (publicationTimeToDateKey(details.publicationTime) === targetDateKey) {
      return details.puzzleId;
    }
  }

  return null;
}

function appendPickerTokens(
  urlFromId: string,
  pickerHtml: string,
  pickerUrl: string,
  puzzleId: string,
  uid?: string,
): string {
  let solverUrl = urlFromId;

  let rawsps: string | undefined;
  if (pickerHtml.includes('pickerParams.rawsps')) {
    for (const line of pickerHtml.split('\n')) {
      if (line.includes('pickerParams.rawsps')) {
        rawsps = line.trim().split("'")[1];
        break;
      }
    }
  } else {
    rawsps = parsePickerParams(pickerHtml).rawsps;
  }

  if (rawsps) {
    const pickerParams = JSON.parse(Buffer.from(rawsps, 'base64').toString('utf-8'));
    const token = pickerParams.loadToken;
    if (token) {
      solverUrl += `&loadToken=${token}`;
    }
  }

  const setName = new URL(pickerUrl).searchParams.get('set') ?? undefined;
  if (setName && puzzleId && uid) {
    solverUrl += `&fvlt=${computeFvlt(setName, puzzleId, uid)}`;
  }

  return solverUrl;
}

export function findAmuseLabsEmbedUrl(pageHtml: string, pageUrl = ''): string | null {
  const root = parse(pageHtml);

  const iframeSources = root.querySelectorAll('iframe')
    .flatMap((iframe) => {
      const src = iframe.getAttribute('data-crossword-url')
        ?? iframe.getAttribute('data-src')
        ?? iframe.getAttribute('src')
        ?? '';
      if (!src || src === 'about:blank') {
        return [];
      }
      try {
        return [new URL(src, pageUrl).toString()];
      } catch {
        return [];
      }
    });

  for (const embedSrc of iframeSources) {
    const parsed = new URL(embedSrc);
    if (!parsed.hostname.includes('amuselabs.com')) {
      continue;
    }
    if (parsed.pathname.includes('crossword')) {
      return embedSrc;
    }
    if (parsed.pathname.endsWith('date-picker')) {
      const idx = parsed.searchParams.get('idx');
      if (!idx) {
        continue;
      }
      const pickerIndex = Number.parseInt(idx, 10) - 1;
      throw new Error(
        `AmuseLabs date-picker iframe requires async fetch: ${embedSrc} idx=${pickerIndex}`,
      );
    }
  }

  const scriptSources = root.querySelectorAll('script[src]')
    .map((script) => script.getAttribute('src') ?? '');

  if (scriptSources.some((src) => src.endsWith('puzzleme-embed.js'))) {
    const basePathMatch = /PM_BasePath\s*=\s*"(.*)"/.exec(pageHtml);
    const embedDiv = root.querySelector('div.pm-embed-div');
    const puzzleId = embedDiv?.getAttribute('data-id');
    const puzzleSet = embedDiv?.getAttribute('data-set');
    const basePath = basePathMatch?.[1];

    if (basePath && puzzleId && puzzleSet) {
      return `${basePath}crossword?id=${puzzleId}&set=${puzzleSet}`;
    }
  }

  return null;
}

async function fetchAmuseLabsJson(solverUrl: string): Promise<AmuseLabsData> {
  const response = await fetchText(solverUrl);
  const html = await response.text();

  if (
    !response.ok
    || html.includes('The puzzle you are trying to access was not found')
  ) {
    throw new Error(`Could not fetch AmuseLabs solver at ${solverUrl}`);
  }

  let rawc: string | undefined;
  if (html.includes('window.rawc') || html.includes('window.puzzleEnv.rawc')) {
    for (const line of html.split('\n')) {
      if (line.includes('window.rawc') || line.includes('window.puzzleEnv.rawc')) {
        rawc = line.trim().split("'")[1];
        break;
      }
    }
  } else {
    const root = parse(html);
    const paramTag = root.querySelector('script#params');
    if (!paramTag?.text) {
      throw new Error('Crossword puzzle not found. Could not find AmuseLabs params.');
    }
    rawc = JSON.parse(paramTag.text).rawc;
  }

  if (!rawc) {
    throw new Error('Unable to find rawc object in AmuseLabs page');
  }

  const xwordData = JSON.parse(deobfuscateRawc(rawc)) as AmuseLabsData;
  if (!xwordData?.box) {
    throw new Error('Unable to decode AmuseLabs rawc object');
  }

  return xwordData;
}

function buildScrapedPuzzleFromAmuseLabs(
  xwData: AmuseLabsData,
  options: {
    publicationId: PublicationId;
    date: Date;
    sourceLink: string;
    titleOverride?: string;
  },
): ScrapedPuzzle {
  const width = xwData.w;
  const height = xwData.h;
  const circled = new Set(
    (xwData.cellInfos ?? [])
      .filter((square) => square.isCircled)
      .map((square) => `${square.x},${square.y}`),
  );

  const grid: Square[][] = [];
  for (let row = 0; row < height; row += 1) {
    const rowSquares: Square[] = [];
    for (let col = 0; col < width; col += 1) {
      const cell = xwData.box[col]?.[row] ?? '\x00';
      const isBlack = cell === '\x00';
      let content = '';

      if (!isBlack) {
        if (typeof cell === 'string' && cell.length === 1) {
          content = cell.toUpperCase();
        } else if (!cell) {
          content = 'X';
        } else if (typeof cell === 'string') {
          content = stripAccents(cell).toUpperCase();
        }
      }

      rowSquares.push({
        row,
        col,
        directions: [],
        isBlack,
        content,
        isCircled: circled.has(`${col},${row}`),
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
  const sortedWords = [...xwData.placedWords].sort(
    (a, b) => a.y - b.y || a.x - b.x || Number(!a.acrossNotDown) - Number(!b.acrossNotDown),
  );

  for (const word of sortedWords) {
    const square = grid[word.y]?.[word.x];
    if (!square?.number) {
      continue;
    }

    const direction = word.acrossNotDown ? 'A' : 'D';
    const index = `${square.number}${direction}`;
    const letters: string[] = [];

    if (word.acrossNotDown) {
      for (let col = word.x; col < width && !grid[word.y][col].isBlack; col += 1) {
        letters.push(grid[word.y][col].content);
      }
    } else {
      for (let row = word.y; row < height && !grid[row][word.x].isBlack; row += 1) {
        letters.push(grid[row][word.x].content);
      }
    }

    entries.set(index, {
      index,
      clue: word.clue?.clue ?? '',
      entry: letters.join(''),
    });
  }

  let puzzleDate = new Date(
    options.date.getFullYear(),
    options.date.getMonth(),
    options.date.getDate(),
  );
  if (xwData.publishTime) {
    puzzleDate = new Date(xwData.publishTime);
  }

  let title = (options.titleOverride ?? xwData.title ?? '').trim();
  if (title === '-') {
    title = '';
  }

  return {
    publicationId: options.publicationId,
    title,
    authors: xwData.author?.trim() ? [xwData.author.trim()] : undefined,
    copyright: xwData.copyright?.trim(),
    date: puzzleDate,
    sourceLink: options.sourceLink,
    width,
    height,
    grid,
    entries,
    lang: 'en',
  };
}

export async function fetchAmuseLabsPuzzle(
  solverUrl: string,
  options: {
    publicationId: PublicationId;
    date: Date;
    sourceLink: string;
    titleOverride?: string;
  },
): Promise<ScrapedPuzzle> {
  const xwData = await fetchAmuseLabsJson(solverUrl);
  return buildScrapedPuzzleFromAmuseLabs(xwData, options);
}

export async function fetchAmuseLabsById(
  puzzleId: string,
  config: AmuseLabsOutletConfig,
  options: {
    publicationId: PublicationId;
    date: Date;
    sourceLink: string;
    titleOverride?: string;
  },
): Promise<ScrapedPuzzle> {
  const solverUrl = config.urlFromId.replace('{puzzle_id}', puzzleId);
  return fetchAmuseLabsPuzzle(solverUrl, options);
}

export async function fetchAmuseLabsLatestFromPicker(
  config: AmuseLabsOutletConfig,
  options: {
    publicationId: PublicationId;
    date: Date;
    sourceLink: string;
    titleOverride?: string;
  },
): Promise<ScrapedPuzzle> {
  if (!config.pickerUrl) {
    throw new Error('Picker URL is required to fetch latest AmuseLabs puzzle.');
  }

  const pickerResponse = await fetchText(config.pickerUrl);
  const pickerHtml = await pickerResponse.text();
  const puzzleId = selectPuzzleIdFromPicker(pickerHtml, 0);
  const uid = extractCookieValue(pickerResponse.headers.get('set-cookie'), 'uid');

  let solverUrl = config.urlFromId.replace('{puzzle_id}', puzzleId);
  solverUrl = appendPickerTokens(solverUrl, pickerHtml, config.pickerUrl, puzzleId, uid);

  return fetchAmuseLabsPuzzle(solverUrl, options);
}

export async function fetchAmuseLabsFromPickerByDate(
  config: AmuseLabsOutletConfig,
  date: Date,
  options: {
    publicationId: PublicationId;
    sourceLink: string;
    titleOverride?: string;
  },
): Promise<ScrapedPuzzle | null> {
  if (!config.pickerUrl) {
    throw new Error('Picker URL is required to fetch AmuseLabs puzzle by date.');
  }

  const pickerResponse = await fetchText(config.pickerUrl);
  const pickerHtml = await pickerResponse.text();
  const puzzleId = selectPuzzleIdFromPickerByDate(pickerHtml, date);
  if (!puzzleId) {
    return null;
  }

  const uid = extractCookieValue(pickerResponse.headers.get('set-cookie'), 'uid');

  let solverUrl = config.urlFromId.replace('{puzzle_id}', puzzleId);
  solverUrl = appendPickerTokens(solverUrl, pickerHtml, config.pickerUrl, puzzleId, uid);

  return fetchAmuseLabsPuzzle(solverUrl, {
    publicationId: options.publicationId,
    date,
    sourceLink: options.sourceLink,
    titleOverride: options.titleOverride,
  });
}
