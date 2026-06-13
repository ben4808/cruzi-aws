import { PublicationId, ScrapedPuzzle } from 'cruzi-models';
import { fetchKingFeaturesPuzzle } from '../lib/kingFeaturesPuzzle';
import { PuzzleSource } from '../scraper/PuzzleSource';

export class ShefferSource implements PuzzleSource {
  public id = 'Sheffer';
  public name = 'Eugene Sheffer';

  public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
    if (date.getDay() === 0) {
      return null;
    }

    const puzzle = await fetchKingFeaturesPuzzle('sheffer', date, {
      publicationId: this.id as PublicationId,
      defaultTitle: 'Eugene Sheffer',
      parseErrorMessage: 'Failed to parse Eugene Sheffer puzzle data.',
    });

    if (puzzle) {
      puzzle.authors = ['Eugene Sheffer'];
    }
    return puzzle;
  }
}
