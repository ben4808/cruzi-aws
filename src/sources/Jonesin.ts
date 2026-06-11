import { PublicationId, ScrapedPuzzle } from 'cruzi-models';
import { processPuzData } from '../lib/puzFiles';
import { PuzzleSource } from '../scraper/PuzzleSource';

export class JonesinSource implements PuzzleSource {
  public id = 'Jonesin';
  public name = "Jonesin'";

  public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
    if (date.getDay() !== 4) {
      return null;
    }

    const dateString = `${date.getFullYear().toString().slice(2)}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`;
    const url = `https://herbach.dnsalias.com/Jonesin/jz${dateString}.puz`;
    const response = await fetch(url);
    const blobResponse = await response.blob();
    const puzzle = await processPuzData(blobResponse);

    if (!puzzle) {
      throw new Error("Failed to parse Jonesin' puzzle data.");
    }

    puzzle.lang = 'en';
    puzzle.publicationId = this.id as PublicationId;
    puzzle.date = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    puzzle.sourceLink = url;

    return puzzle;
  }
}
