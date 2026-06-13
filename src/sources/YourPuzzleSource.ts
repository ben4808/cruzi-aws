import { PublicationId } from 'cruzi-models';
import { fetchAmuseLabsFromPickerByPickerTitleDate } from '../lib/amuseLabs';
import { PuzzleSource } from '../scraper/PuzzleSource';

const DAILY_PAGE_URL = 'https://yourpuzzlesource.com/puzzles/daily-crossword/';
const WEEKEND_PAGE_URL = 'https://yourpuzzlesource.com/puzzles/weekend-crossword/';

const DAILY_PICKER_URL = 'https://app.amuselabs.com/app/date-picker?set=yps&embed=1';
const WEEKEND_PICKER_URL = 'https://app.amuselabs.com/app/date-picker?set=yps-15x15&embed=1';

const DAILY_CROSSWORD_URL = 'https://app.amuselabs.com/app/crossword?id={puzzle_id}&set=yps&embed=1';
const WEEKEND_CROSSWORD_URL = 'https://app.amuselabs.com/app/crossword?id={puzzle_id}&set=yps-15x15&embed=1';

export class YourPuzzleSource implements PuzzleSource {
  public id = 'YourPuzzleSource';
  public name = 'Your Puzzle Source';

  public getPuzzle(date: Date) {
    const day = date.getDay();
    if (day === 0) {
      return Promise.resolve(null);
    }

    if (day === 6) {
      return fetchAmuseLabsFromPickerByPickerTitleDate(
        {
          pickerUrl: WEEKEND_PICKER_URL,
          urlFromId: WEEKEND_CROSSWORD_URL,
          setName: 'yps-15x15',
        },
        date,
        {
          publicationId: this.id as PublicationId,
          sourceLink: WEEKEND_PAGE_URL,
        },
      );
    }

    return fetchAmuseLabsFromPickerByPickerTitleDate(
      {
        pickerUrl: DAILY_PICKER_URL,
        urlFromId: DAILY_CROSSWORD_URL,
        setName: 'yps',
      },
      date,
      {
        publicationId: this.id as PublicationId,
        sourceLink: DAILY_PAGE_URL,
      },
    );
  }
}
