import { ScrapedPuzzle, PublicationId } from 'cruzi-models';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { processPuzData } from '../lib/puzFiles';
import { formatDateKey2 } from '../lib/utils';

const PUZZLE_BASE_URL =
  'https://ams.cdn.arkadiumhosted.com/assets/gamesfeed/best-crosswords-ftp/daily-themed';

function buildPuzzleUrl(date: Date): string {
  return `${PUZZLE_BASE_URL}/puzzle_${formatDateKey2(date)}.puz`;
}

export class BestCrosswordsSource implements PuzzleSource {
  public id = 'BestCrosswords';
  public name = 'Best Crosswords';

  public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
    const url = buildPuzzleUrl(date);
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const puzzle = await processPuzData(await response.blob());

    if (!puzzle) {
      throw new Error('Failed to parse Best Crosswords puzzle data.');
    }

    puzzle.lang = 'en';
    puzzle.publicationId = this.id as PublicationId;
    puzzle.date = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    puzzle.sourceLink = url;

    return puzzle;
  }
}
