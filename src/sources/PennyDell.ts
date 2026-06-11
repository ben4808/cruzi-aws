import { PublicationId } from 'cruzi-models';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { parseCrosswordCompilerXml } from '../lib/crosswordCompilerXml';
import { formatDateKey2 } from '../lib/utils';

const PUZZLE_BASE_URL =
  'https://ams.cdn.arkadiumhosted.com/assets/gamesfeed/penny-dell/brain-booster';

function buildPuzzleUrl(date: Date): string {
  return `${PUZZLE_BASE_URL}/puzzle_${formatDateKey2(date)}.xml`;
}

export class PennyDellSource implements PuzzleSource {
  public id = 'PennyDell';
  public name = 'Penny Dell';

  public async getPuzzle(date: Date) {
    const url = buildPuzzleUrl(date);
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const puzzle = parseCrosswordCompilerXml(await response.text(), {
      publicationId: this.id as PublicationId,
      date,
      sourceLink: url,
      defaultTitle: 'Penny Dell Brain Booster',
    });

    if (!puzzle) {
      throw new Error('Failed to parse Penny Dell puzzle data.');
    }

    return puzzle;
  }
}
