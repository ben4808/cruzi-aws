import { PublicationId } from 'cruzi-models';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { parseCrosswordCompilerXml } from '../lib/crosswordCompilerXml';
import { formatDateKey2 } from '../lib/utils';

const PUZZLE_BASE_URL =
  'https://ams.cdn.arkadiumhosted.com/assets/gamesfeed/penny-dell/sunday-crossword';

function buildPuzzleUrl(date: Date): string {
  return `${PUZZLE_BASE_URL}/puzzle_${formatDateKey2(date)}.xml`;
}

export class PennyDellSundaySource implements PuzzleSource {
  public id = 'PennyDellSunday';
  public name = 'Penny Dell Sunday';

  public async getPuzzle(date: Date) {
    if (date.getDay() !== 0) {
      return null;
    }

    const url = buildPuzzleUrl(date);
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const puzzle = parseCrosswordCompilerXml(await response.text(), {
      publicationId: this.id as PublicationId,
      date,
      sourceLink: url,
      defaultTitle: 'Penny Dell Sunday Crossword',
    });

    if (!puzzle) {
      throw new Error('Failed to parse Penny Dell Sunday puzzle data.');
    }

    return puzzle;
  }
}
