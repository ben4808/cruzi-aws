import { PublicationId } from 'cruzi-models';
import { fetchPuzzmoBigPuzzle } from '../lib/puzzmo';
import { formatDateKey } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

function buildPuzzmoBigSourceLink(date: Date): string {
  return `https://www.puzzmo.com/puzzle/${formatDateKey(date)}/crossword/big`;
}

export class PuzzmoBigSource implements PuzzleSource {
  public id = 'PuzzmoBig';
  public name = 'Puzzmo Big';

  public getPuzzle(date: Date) {
    return fetchPuzzmoBigPuzzle(date, {
      publicationId: this.id as PublicationId,
      sourceLink: buildPuzzmoBigSourceLink(date),
    });
  }
}
