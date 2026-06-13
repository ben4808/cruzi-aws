import { PublicationId } from 'cruzi-models';
import { parse } from 'node-html-parser';
import { fetchAmuseLabsById } from '../lib/amuseLabs';
import { formatDateKeyYYYYMMDD } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

const PAGE_URL = 'https://www.merriam-webster.com/games/missing-letter';
const GROUP_PICKER_URL = 'https://cdn2.amuselabs.com/mw/group-picker';
const CROSSWORD_URL = 'https://cdn2.amuselabs.com/mw/crossword?id={puzzle_id}&set=mw-tml-daily';
const SET_NAME = 'mw-tml-daily';
const USER_AGENT = 'cruzi-aws-crossword-scraper';

interface GroupPickerPuzzle {
  id: string;
}

function buildPuzzleId(date: Date): string {
  return `mw_${formatDateKeyYYYYMMDD(date)}`;
}

async function fetchGroupPickerPuzzles(): Promise<GroupPickerPuzzle[]> {
  const params = new URLSearchParams({
    set: SET_NAME,
    embed: 'js',
    limit: '28',
    src: PAGE_URL,
  });

  const response = await fetch(`${GROUP_PICKER_URL}?${params}`, {
    headers: {
      'User-Agent': USER_AGENT,
      Referer: PAGE_URL,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Merriam-Webster picker (${response.status})`);
  }

  const html = await response.text();
  const root = parse(html);
  const paramTag = root.querySelector('script#params');
  if (!paramTag?.text) {
    throw new Error('Merriam-Webster picker params not found');
  }

  const pickerParams = JSON.parse(paramTag.text) as { rawpuz?: string };
  if (!pickerParams.rawpuz) {
    throw new Error('Merriam-Webster picker puzzle list not found');
  }

  return JSON.parse(
    Buffer.from(pickerParams.rawpuz, 'base64').toString('utf-8'),
  ) as GroupPickerPuzzle[];
}

function selectPuzzleIdFromPicker(puzzles: GroupPickerPuzzle[], date: Date): string | null {
  const targetId = buildPuzzleId(date);
  return puzzles.some((puzzle) => puzzle.id === targetId) ? targetId : null;
}

export class MerriamWebsterSource implements PuzzleSource {
  public id = 'MerriamWebster';
  public name = 'Merriam-Webster';

  public async getPuzzle(date: Date) {
    const puzzles = await fetchGroupPickerPuzzles();
    const puzzleId = selectPuzzleIdFromPicker(puzzles, date);
    if (!puzzleId) {
      return null;
    }

    const puzzle = await fetchAmuseLabsById(
      puzzleId,
      {
        urlFromId: CROSSWORD_URL,
        setName: SET_NAME,
      },
      {
        publicationId: this.id as PublicationId,
        date,
        sourceLink: PAGE_URL,
      },
    );

    puzzle.title = `The Missing Letter`;
    puzzle.authors = ['Matt Gaffney'];
    return puzzle;
  }
}
