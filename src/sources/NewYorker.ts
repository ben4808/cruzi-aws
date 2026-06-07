import { ScrapedPuzzle, PublicationId } from 'cruzi-models';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { processPuzData } from "../lib/puzFiles";
import { formatDateKey } from '../lib/utils';

const execAsync = promisify(exec);
const PUZZLES_DIR = 'C:\\Users\\ben_z\\Desktop\\puzzles';

export class NewYorkerSource implements PuzzleSource {
    public id = "NewYorker";
    public name = "New Yorker";

    public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
      // Return null unless it's a Monday, Tuesday, or Wednesday.
      if (date.getDay() !== 1 && date.getDay() !== 2 && date.getDay() !== 3) {
        return null;
      }
      const dateString = formatDateKey(date);
      const filename = `NewYorker-${dateString}.puz`;
      const puzPath = path.join(PUZZLES_DIR, filename);

      await fs.promises.mkdir(PUZZLES_DIR, { recursive: true });
      await execAsync(`xword-dl tny --date ${dateString} --output ${filename}`, {
        cwd: PUZZLES_DIR,
      });

      const buffer = await fs.promises.readFile(puzPath);
      const blobResponse = new Blob(
        [new Uint8Array(buffer)],
        { type: 'application/octet-stream' },
      );
      const puzzle = await processPuzData(blobResponse);

      if (!puzzle) {
        throw new Error("Failed to parse New Yorker puzzle data.");
      }

      puzzle.lang = "en";
      puzzle.publicationId = this.id as PublicationId;
      puzzle.date = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      puzzle.sourceLink = `https://www.newyorker.com/puzzles/new-yorker-crossword/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;

      return puzzle;
    }
}
