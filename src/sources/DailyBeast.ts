import { PublicationId } from 'cruzi-models';
import { fetchAmuseLabsLatestFromPicker } from '../lib/amuseLabs';
import { parseLooseDate } from '../lib/xdFormat';
import { formatDateKey, getPuzzleDate } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

export class DailyBeastSource implements PuzzleSource {
  public id = 'DailyBeast';
  public name = 'Daily Beast';

  public async getPuzzle(date: Date) {
    const today = getPuzzleDate();
    if (formatDateKey(date) !== formatDateKey(today)) {
      return null;
    }

    const puzzle = await fetchAmuseLabsLatestFromPicker(
      {
        pickerUrl: 'https://cdn3.amuselabs.com/tdb/date-picker?set=tdb',
        urlFromId: 'https://cdn3.amuselabs.com/tdb/crossword?id={puzzle_id}&set=tdb',
        setName: 'tdb',
      },
      {
        publicationId: this.id as PublicationId,
        date,
        sourceLink: 'https://www.thedailybeast.com/crossword-puzzles/',
      },
    );

    const titleWithoutPeriods = puzzle.title.replace(/\./g, '');
    const parsedDate = parseLooseDate(titleWithoutPeriods);
    if (parsedDate) {
      puzzle.date = new Date(
        parsedDate.getFullYear(),
        parsedDate.getMonth(),
        parsedDate.getDate(),
      );
    }

    return puzzle;
  }
}
