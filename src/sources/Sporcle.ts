import { PublicationId } from 'cruzi-models';
import { fetchSporcleSundayPuzzle } from '../lib/sporcle';
import { formatDateKey, getPuzzleDate } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

export class SporcleSource implements PuzzleSource {
  public id = 'Sporcle';
  public name = 'Sporcle';

  public async getPuzzle(date: Date) {
    const today = getPuzzleDate();
    if (formatDateKey(date) !== formatDateKey(today)) {
      return null;
    }

    return fetchSporcleSundayPuzzle({
      publicationId: this.id as PublicationId,
    });
  }
}
