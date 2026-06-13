import { PublicationId, ScrapedPuzzle } from 'cruzi-models';
import { fetchKingFeaturesPuzzle } from '../lib/kingFeaturesPuzzle';
import { PuzzleSource } from '../scraper/PuzzleSource';

export class JosephSource implements PuzzleSource {
  public id = 'Joseph';
  public name = 'Thomas Joseph';

  public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
    if (date.getDay() === 0) {
      return null;
    }

    const puzzle = await fetchKingFeaturesPuzzle('joseph', date, {
      publicationId: this.id as PublicationId,
      defaultTitle: 'Thomas Joseph',
      parseErrorMessage: 'Failed to parse Thomas Joseph puzzle data.',
    });

    if (puzzle) {
      puzzle.authors = ['Thomas Joseph'];
    }
    return puzzle;
  }
}
