import { PublicationId } from 'cruzi-models';
import { fetchAmuseLabsLatestFromPicker } from '../lib/amuseLabs';
import { formatDateKey, getPuzzleDate } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

export class TheWalrusSource implements PuzzleSource {
  public id = 'TheWalrus';
  public name = 'The Walrus';

  public async getPuzzle(date: Date) {
    const today = getPuzzleDate();
    if (formatDateKey(date) !== formatDateKey(today)) {
      return null;
    }

    return fetchAmuseLabsLatestFromPicker(
      {
        pickerUrl: 'https://cdn2.amuselabs.com/pmm/date-picker?set=walrus-weekly-crossword',
        urlFromId: 'https://cdn2.amuselabs.com/pmm/crossword?id={puzzle_id}&set=walrus-weekly-crossword',
        setName: 'walrus-weekly-crossword',
      },
      {
        publicationId: this.id as PublicationId,
        date,
        sourceLink: 'https://thewalrus.ca/weekly-crossword/',
      },
    );
  }
}
