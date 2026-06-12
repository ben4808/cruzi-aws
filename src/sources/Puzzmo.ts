import { PublicationId } from 'cruzi-models';
import { fetchPuzzmoPuzzle } from '../lib/puzzmo';
import { formatDateKey } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

function buildPuzzmoSourceLink(date: Date): string {
  return `https://www.puzzmo.com/puzzle/${formatDateKey(date)}/crossword`;
}

export class PuzzmoSource implements PuzzleSource {
  public id = 'Puzzmo';
  public name = 'Puzzmo';

  public getPuzzle(date: Date) {
    return fetchPuzzmoPuzzle(date, {
      publicationId: this.id as PublicationId,
      sourceLink: buildPuzzmoSourceLink(date),
    });
  }
}
