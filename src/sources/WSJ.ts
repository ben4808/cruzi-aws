import { PuzzleSource } from "../models/PuzzleSource";
import { Puzzle } from "../models/Puzzle";
import { processPuzData } from "../lib/puzFiles";

export class WSJSource implements PuzzleSource {
    public id = "WSJ";
    public name = "Wall Street Journal";

    public async getPuzzle(date: Date): Promise<Puzzle> {
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
      puzzle.publication = this.id;
      puzzle.sourceLink = url; // Link to the source of the puzzle
      return puzzle;
    }
}
