import { ScrapedPuzzle, PublicationId } from 'cruzi-models';
import puppeteer from 'puppeteer';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { processPuzData } from "../lib/puzFiles";
import { isoDatetimeToPuzzleCalendarDate } from '../lib/utils';

const CROCE_HOMEPAGE_URL = 'https://club72.wordpress.com/';

interface CrocePostInfo {
  postedDate: string;
  puzUrl: string | null;
  postUrl: string;
  title: string;
}

async function scrapeLatestCrocePost(): Promise<{ postInfo: CrocePostInfo; blob: Blob } | null> {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(CROCE_HOMEPAGE_URL, { waitUntil: 'networkidle2' });

    const postInfo = await page.evaluate(() => {
      const article = document.querySelector('article');
      if (!article) {
        return null;
      }

      const titleEl = article.querySelector('.entry-title a');
      const timeEl = article.querySelector('time.entry-date');
      const entryContent = article.querySelector('.entry-content');

      let puzUrl: string | null = null;
      if (entryContent) {
        for (const link of Array.from(entryContent.querySelectorAll('a'))) {
          const href = link.getAttribute('href');
          const text = link.textContent?.trim().toUpperCase() ?? '';
          if (href && text.includes('PUZ')) {
            puzUrl = href;
            break;
          }
        }
      }

      const postedDate = timeEl?.getAttribute('datetime');
      if (!postedDate) {
        return null;
      }

      return {
        postedDate,
        puzUrl,
        postUrl: titleEl?.getAttribute('href') ?? '',
        title: titleEl?.textContent?.trim() ?? '',
      };
    });

    if (!postInfo) {
      console.log('Croce: No featured crossword found on homepage.');
      return null;
    }

    if (!postInfo.puzUrl) {
      console.log(`Croce: No PUZ link found for "${postInfo.title}".`);
      return null;
    }

    const absoluteUrl = postInfo.puzUrl.startsWith('http')
      ? postInfo.puzUrl
      : new URL(postInfo.puzUrl, CROCE_HOMEPAGE_URL).href;

    const response = await fetch(absoluteUrl);
    if (!response.ok) {
      throw new Error(`Failed to download Croce puzzle (${response.status}).`);
    }

    return {
      postInfo,
      blob: new Blob([new Uint8Array(await response.arrayBuffer())]),
    };
  } finally {
    await browser.close();
  }
}

export class CroceSource implements PuzzleSource {
    public id = "Croce";
    public name = "Club 72 (Croce)";

    public async getPuzzle(_date: Date): Promise<ScrapedPuzzle | null> {
      const result = await scrapeLatestCrocePost();
      if (!result) {
        return null;
      }

      const puzzle = await processPuzData(result.blob);
      if (!puzzle) {
        throw new Error("Failed to parse Croce puzzle data.");
      }

      const postedDate = isoDatetimeToPuzzleCalendarDate(result.postInfo.postedDate);

      puzzle.lang = "en";
      puzzle.publicationId = this.id as PublicationId;
      puzzle.date = postedDate;
      puzzle.sourceLink = result.postInfo.postUrl || CROCE_HOMEPAGE_URL;

      return puzzle;
    }
}
