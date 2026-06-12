import { PublicationId } from 'cruzi-models';
import { fetchAmuseLabsById } from '../lib/amuseLabs';
import { formatDateKeyYYYYMMDD } from '../lib/utils';
import { PuzzleSource } from '../scraper/PuzzleSource';

function buildAtlanticSourceLink(date: Date): string {
  return `https://cdn3.amuselabs.com/atlantic/crossword?id=atlantic_${formatDateKeyYYYYMMDD(date)}&set=atlantic`;
}

export class AtlanticSource implements PuzzleSource {
  public id = 'Atlantic';
  public name = 'The Atlantic';

  public getPuzzle(date: Date) {
    const puzzleId = `atlantic_${formatDateKeyYYYYMMDD(date)}`;
    return fetchAmuseLabsById(
      puzzleId,
      {
        urlFromId: 'https://cdn3.amuselabs.com/atlantic/crossword?id={puzzle_id}&set=atlantic',
      },
      {
        publicationId: this.id as PublicationId,
        date,
        sourceLink: buildAtlanticSourceLink(date),
      },
    );
  }
}
