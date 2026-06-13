import { PublicationId, ScrapedPuzzle } from 'cruzi-models';
import { fetchKingFeaturesPuzzle } from '../lib/kingFeaturesPuzzle';
import { PuzzleSource } from '../scraper/PuzzleSource';

export class PremierSource implements PuzzleSource {
  public id = 'Premier';
  public name = 'Premier Sunday';

  public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
    if (date.getDay() !== 0) {
      return null;
    }

    const puzzle = await fetchKingFeaturesPuzzle('premier', date, {
      publicationId: this.id as PublicationId,
      defaultTitle: 'Premier Sunday',
      parseErrorMessage: 'Failed to parse Premier Sunday puzzle data.',
    });

    if (puzzle) {
      puzzle.authors = ['Frank Longo'];
    }
    return puzzle;
  }
}
