import { ScrapedPuzzle, PublicationId } from 'cruzi-models';
import puppeteer from 'puppeteer';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { processPuzData } from "../lib/puzFiles";

const CRUCIVERB_LOGIN_URL = 'https://www.cruciverb.com/index.php';

async function downloadCruciverbPuz(url: string): Promise<Blob> {
  const user = process.env.CRUCIVERB_USER;
  const pass = process.env.CRUCIVERB_PASS;
  if (!user || !pass) {
    throw new Error('CRUCIVERB_USER and CRUCIVERB_PASS environment variables are required.');
  }

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();

    await page.goto(CRUCIVERB_LOGIN_URL, { waitUntil: 'networkidle2' });
    await page.type('#user', user);
    await page.type('#passwrd', pass);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
      page.click('form[action*="action=login2"] input[type="submit"]'),
    ]);

    const bytes = await page.evaluate(async (downloadUrl) => {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to download LAT puzzle (${response.status}).`);
      }
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, url);

    return new Blob([new Uint8Array(bytes)]);
  } finally {
    await browser.close();
  }
}

export class LATSource implements PuzzleSource {
    public id = "LAT";
    public name = "Los Angeles Times";

    public async getPuzzle(date: Date): Promise<ScrapedPuzzle | null> {
      let dateString = `${date.getFullYear().toString().slice(2)}${(date.getMonth()+1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}`;
      let url = `https://www.cruciverb.com/download.php?f=lat${dateString}.puz`;
      let blobResponse = await downloadCruciverbPuz(url);
      let puzzle = await processPuzData(blobResponse);

      if (!puzzle) {
        throw new Error("Failed to parse LAT puzzle data.");
      }

      puzzle.lang = "en";
      puzzle.publicationId = this.id as PublicationId;
      puzzle.date = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      puzzle.sourceLink = url;

      return puzzle;
    }
}
