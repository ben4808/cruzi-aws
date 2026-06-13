import { PublicationId } from 'cruzi-models';
import { fetchAmuseLabsLatestFromPicker } from '../lib/amuseLabs';
import { parseLooseDate } from '../lib/xdFormat';
import { formatDateKey, getPuzzleDate, toCalendarDate } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

export class DailyBeastSource implements PuzzleSource {
  public id = 'DailyBeast';
  public name = 'Daily Beast';

  public async getPuzzle(date: Date) {
    if (date.getDay() === 5 || date.getDay() === 6) {
      return null;
    }

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
      puzzle.date = toCalendarDate(parsedDate);
    }

    return puzzle;
  }
}
