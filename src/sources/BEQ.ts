import { ScrapedPuzzle, PublicationId } from 'cruzi-models';
import puppeteer from 'puppeteer';
import { PuzzleSource } from '../scraper/PuzzleSource';
import { processPuzData } from "../lib/puzFiles";

const BEQ_HOMEPAGE_URL = 'https://brendanemmettquigley.com/';

interface BeqPostInfo {
  postedDate: string;
  acrossLiteUrl: string | null;
  postUrl: string;
  title: string;
}

function parsePostedDate(datetime: string): Date {
  const datePart = datetime.split('T')[0];
  const [year, month, day] = datePart.split('-').map(Number);
  return new Date(year, month - 1, day);
}

async function scrapeLatestBeqPost(): Promise<{ postInfo: BeqPostInfo; blob: Blob } | null> {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(BEQ_HOMEPAGE_URL, { waitUntil: 'networkidle2' });

    const postInfo = await page.evaluate(() => {
      const article = document.querySelector('article');
      if (!article) {
        return null;
      }

      const titleEl = article.querySelector('.entry-title a');
      const timeEl = article.querySelector('time.entry-date.published');
      const entryContent = article.querySelector('.entry-content');

      let acrossLiteUrl: string | null = null;
      if (entryContent) {
        for (const link of Array.from(entryContent.querySelectorAll('a'))) {
          const href = link.getAttribute('href');
          const text = link.textContent?.trim().toUpperCase() ?? '';
          if (href?.endsWith('.puz') && text.includes('ACROSS LITE')) {
            acrossLiteUrl = href;
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
        acrossLiteUrl,
        postUrl: titleEl?.getAttribute('href') ?? '',
        title: titleEl?.textContent?.trim() ?? '',
      };
    });

    if (!postInfo) {
      console.log('BEQ: No featured crossword found on homepage.');
      return null;
    }

    if (!postInfo.acrossLiteUrl) {
      console.log(`BEQ: No Across Lite link found for "${postInfo.title}".`);
      return null;
    }

    const absoluteUrl = postInfo.acrossLiteUrl.startsWith('http')
      ? postInfo.acrossLiteUrl
      : new URL(postInfo.acrossLiteUrl, BEQ_HOMEPAGE_URL).href;

    const bytes = await page.evaluate(async (downloadUrl) => {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to download BEQ puzzle (${response.status}).`);
      }
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, absoluteUrl);

    return {
      postInfo,
      blob: new Blob([new Uint8Array(bytes)]),
    };
  } finally {
    await browser.close();
  }
}

export class BEQSource implements PuzzleSource {
    public id = "BEQ";
    public name = "Brendan Emmett Quigley";

    public async getPuzzle(_date: Date): Promise<ScrapedPuzzle | null> {
      const result = await scrapeLatestBeqPost();
      if (!result) {
        return null;
      }

      const puzzle = await processPuzData(result.blob);
      if (!puzzle) {
        throw new Error("Failed to parse BEQ puzzle data.");
      }

      const postedDate = parsePostedDate(result.postInfo.postedDate);

      puzzle.lang = "en";
      puzzle.publicationId = this.id as PublicationId;
      puzzle.date = postedDate;
      puzzle.sourceLink = result.postInfo.postUrl || BEQ_HOMEPAGE_URL;

      return puzzle;
    }
}
