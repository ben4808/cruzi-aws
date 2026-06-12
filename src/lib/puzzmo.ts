import { PublicationId, ScrapedPuzzle } from 'cruzi-models';
import { parseLooseDate, parseXdFormat } from './xdFormat';
import { formatDateKey, getPuzzleDate } from './utils';

const GRAPHQL_URL = 'https://www.puzzmo.com/_api/prod/graphql?PlayGameScreenQuery';
const USER_AGENT = 'cruzi-aws-crossword-scraper';

const PLAY_GAME_QUERY = `query PlayGameScreenQuery(
  $finderKey: String!
  $gameContext: StartGameContext!
) {
  startOrFindGameplay(finderKey: $finderKey, context: $gameContext) {
    __typename
    ... on ErrorableResponse {
      message
      failed
      success
    }
    ...on HasGamePlayed {
      gamePlayed{
        puzzle {
          name
          emoji
          puzzle
          dailyTitle
          author
          authors {
            publishingName
            username
            usernameID
            name
            id
          }
        }
      }
    }
  }
}`;

interface PuzzmoAuthor {
  publishingName?: string;
  name?: string;
}

interface PuzzmoPuzzlePayload {
  name?: string;
  puzzle: string;
  dailyTitle: string;
  authors?: PuzzmoAuthor[];
}

function getPuzzmoDate(dt: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(dt);

  const year = Number(parts.find((part) => part.type === 'year')!.value);
  const month = Number(parts.find((part) => part.type === 'month')!.value) - 1;
  const day = Number(parts.find((part) => part.type === 'day')!.value);
  const hour = Number(parts.find((part) => part.type === 'hour')!.value);

  const easternDate = new Date(year, month, day);
  if (hour < 1) {
    easternDate.setDate(easternDate.getDate() - 1);
  }
  return easternDate;
}

function joinAuthors(authors: PuzzmoAuthor[] | undefined): string {
  return (authors ?? [])
    .map((author) => author.publishingName || author.name || '')
    .filter(Boolean)
    .join(' & ');
}

function generateGameplayId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

async function fetchPuzzmoPayload(dateString: string, finderKey: string): Promise<PuzzmoPuzzlePayload> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'Puzzmo-Gameplay-Id': generateGameplayId(),
    },
    body: JSON.stringify({
      operationName: 'PlayGameScreenQuery',
      query: PLAY_GAME_QUERY,
      variables: {
        finderKey: finderKey.replace('{date_string}', dateString),
        gameContext: { partnerSlug: null, pingOwnerForMultiplayer: true },
      },
    }),
  });

  const payload = await response.json() as {
    data?: {
      startOrFindGameplay?: {
        __typename?: string;
        message?: string;
        gamePlayed?: { puzzle?: PuzzmoPuzzlePayload };
      };
    };
  };

  const result = payload.data?.startOrFindGameplay;
  if (result?.__typename === 'ErrorableResponse') {
    throw new Error(`Puzzmo error: ${result.message ?? 'Unknown error'}`);
  }

  const puzzle = result?.gamePlayed?.puzzle;
  if (!puzzle?.puzzle) {
    throw new Error('Unable to extract Puzzmo puzzle data.');
  }

  return puzzle;
}

export async function fetchPuzzmoPuzzle(
  date: Date,
  options: {
    publicationId: PublicationId;
    sourceLink: string;
  },
): Promise<ScrapedPuzzle> {
  const dateString = formatDateKey(date);
  const payload = await fetchPuzzmoPayload(dateString, 'today:/{date_string}/crossword');

  const parsedDate = parseLooseDate(payload.dailyTitle)
    ?? parseLooseDate(payload.dailyTitle.split('-')[0] ?? '')
    ?? date;

  const puzzle = parseXdFormat(payload.puzzle, {
    publicationId: options.publicationId,
    date: parsedDate,
    sourceLink: options.sourceLink,
    title: payload.name,
    author: joinAuthors(payload.authors),
  });

  return puzzle;
}

function getMostRecentPuzzmoBigDate(dt: Date): Date {
  const startDate = new Date(2025, 0, 13);
  const lastBiweekly = new Date(2025, 5, 16);
  const firstMonthly = new Date(2025, 6, 7);

  if (dt >= startDate && dt < lastBiweekly) {
    const deltaDays = Math.floor((dt.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
    const evenWeeks = Math.floor(Math.floor(deltaDays / 7) / 2) * 2;
    const result = new Date(startDate);
    result.setDate(result.getDate() + evenWeeks * 7);
    return result;
  }

  if (dt >= lastBiweekly && dt < firstMonthly) {
    return lastBiweekly;
  }

  if (dt >= firstMonthly) {
    let monthWithPuzzle = dt.getMonth();
    if (dt.getDate() <= dt.getDay()) {
      monthWithPuzzle -= 1;
    }
    let yearWithPuzzle = dt.getFullYear();
    if (monthWithPuzzle < 0) {
      monthWithPuzzle = 11;
      yearWithPuzzle -= 1;
    }
    const referenceDate = new Date(yearWithPuzzle, monthWithPuzzle, 7);
    const offset = referenceDate.getDay();
    referenceDate.setDate(referenceDate.getDate() - offset);
    return referenceDate;
  }

  return lastBiweekly;
}

export async function fetchPuzzmoBigPuzzle(
  date: Date,
  options: {
    publicationId: PublicationId;
    sourceLink: string;
  },
): Promise<ScrapedPuzzle | null> {
  const today = getPuzzleDate();
  const puzzmoToday = getPuzzmoDate(today);
  const mostRecentBigDate = getMostRecentPuzzmoBigDate(puzzmoToday);

  if (
    date.getFullYear() !== mostRecentBigDate.getFullYear()
    || date.getMonth() !== mostRecentBigDate.getMonth()
    || date.getDate() !== mostRecentBigDate.getDate()
  ) {
    return null;
  }

  const dateString = formatDateKey(mostRecentBigDate);
  const payload = await fetchPuzzmoPayload(dateString, 'today:/{date_string}/crossword/big');

  const parsedDate = parseLooseDate(payload.dailyTitle)
    ?? parseLooseDate(payload.dailyTitle.split('-')[0] ?? '')
    ?? mostRecentBigDate;

  return parseXdFormat(payload.puzzle, {
    publicationId: options.publicationId,
    date: parsedDate,
    sourceLink: options.sourceLink,
    title: payload.name,
    author: joinAuthors(payload.authors),
  });
}

export { getPuzzmoDate };
