import { ScrapedPuzzle, PublicationId } from 'cruzi-models';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { processPuzData } from "../lib/puzFiles";
import { formatDateKey, formatDateKey2 } from '../lib/utils';

const execAsync = promisify(exec);
const PUZZLES_DIR = 'C:\\Users\\ben_z\\Desktop\\puzzles';

export class USATodaySource implements PuzzleSource {
    public id = "USAToday";
    public name = "USA Today";

    public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
      let dateString = formatDateKey(date);
      //dateString = "06-07-2026";
      const filename = `USAToday-${dateString}.puz`;
      const puzPath = path.join(PUZZLES_DIR, filename);

      await fs.promises.mkdir(PUZZLES_DIR, { recursive: true });
      await execAsync(`xword-dl usa --date ${dateString} --output ${filename}`, {
        cwd: PUZZLES_DIR,
      });

      const buffer = await fs.promises.readFile(puzPath);
      const blobResponse = new Blob(
        [new Uint8Array(buffer)],
        { type: 'application/octet-stream' },
      );
      const puzzle = await processPuzData(blobResponse);

      if (!puzzle) {
        throw new Error("Failed to parse USA Today puzzle data.");
      }

      puzzle.lang = "en";
      puzzle.publicationId = this.id as PublicationId;
      puzzle.date = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      puzzle.sourceLink = `http://picayune.uclick.com/comics/usaon/data/usaon${formatDateKey2(date)}-data.xml`;

      return puzzle;
    }
}
