import { PublicationId, ScrapedPuzzle } from 'cruzi-models';
import { fetchAmuseLabsFromPickerByDate } from '../lib/amuseLabs';
import { PuzzleSource } from '../scraper/PuzzleSource';

const AMUSE_LABS_CONFIG = {
  pickerUrl: 'https://lat.amuselabs.com/lat/date-picker?set=latimes',
  urlFromId: 'https://lat.amuselabs.com/lat/crossword?id={puzzle_id}&set=latimes',
  setName: 'latimes',
};

const SOURCE_LINK = 'https://lat.amuselabs.com/lat/crossword?set=latimes';

export class LATSource implements PuzzleSource {
  public id = 'LAT';
  public name = 'Los Angeles Times';

  public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
    return fetchAmuseLabsFromPickerByDate(AMUSE_LABS_CONFIG, date, {
      publicationId: this.id as PublicationId,
      sourceLink: SOURCE_LINK,
    });
  }
}
