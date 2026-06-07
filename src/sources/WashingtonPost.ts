import { ScrapedPuzzle, PublicationId } from 'cruzi-models';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { processPuzData } from "../lib/puzFiles";

export class WashingtonPostSource implements PuzzleSource {
    public id = "WP";
    public name = "Washington Post";

    public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
      // Return null unless it's a Sunday.
      if (date.getDay() !== 0) {
        return null;
      }
      let dateString = `${date.getFullYear().toString().slice(2)}${(date.getMonth()+1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}`;
      let url = `https://herbach.dnsalias.com/WaPo/wp${dateString}.puz`;
      //url = `https://herbach.dnsalias.com/WaPo/wpYYMMDD.puz`;
      let response = await fetch(url); 
      let blobResponse = await response.blob();
      let puzzle = await processPuzData(blobResponse);

      if (!puzzle) {
        throw new Error("Failed to parse Universal puzzle data.");
      }

      puzzle.lang = "en";
      puzzle.publicationId = this.id as PublicationId;
      puzzle.date = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      puzzle.sourceLink = url; // Link to the source of the puzzle

      return puzzle;
    }
}
