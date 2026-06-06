import { ScrapedPuzzle, PublicationId } from 'cruzi-models';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { processPuzData } from "../lib/puzFiles";

export class WSJSource implements PuzzleSource {
    public id = "WSJ";
    public name = "Wall Street Journal";

    public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
      // Return null if the date is a Friday. WSJ doesn't include solutions for Friday contest puzzles.
      if (date.getDay() === 5) {
        return null;
      }
      let dateString = `${date.getFullYear().toString().slice(2)}${(date.getMonth()+1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}`;
      let url = `https://herbach.dnsalias.com/wsj/wsj${dateString}.puz`;
      //url = `https://herbach.dnsalias.com/wsj/wsjYYMMDD.puz`;
      let response = await fetch(url); 
      let blobResponse = await response.blob();
      let puzzle = await processPuzData(blobResponse);

      if (!puzzle) {
        throw new Error("Failed to parse WSJ puzzle data.");
      }

      puzzle.lang = "en";
      puzzle.publicationId = this.id as PublicationId;
      puzzle.date = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      puzzle.sourceLink = url; // Link to the source of the puzzle
      
      // Remove the "By" prefix from the author and editor name
      puzzle!.authors![0] = puzzle!.authors![0].substring(3);
      puzzle!.authors![0] = puzzle!.authors![0].replace("/Edited by Mike Shenk", "");
      return puzzle;
    }
}
