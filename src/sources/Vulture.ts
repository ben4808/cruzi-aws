import { PublicationId, ScrapedPuzzle } from 'cruzi-models';
import { fetchAmuseLabsPuzzle, findAmuseLabsEmbedUrl } from '../lib/amuseLabs';
import { PuzzleSource } from '../scraper/PuzzleSource';

const USER_AGENT = 'cruzi-aws-crossword-scraper';

async function fetchVulturePuzzle(
  date: Date,
  publicationId: PublicationId,
): Promise<ScrapedPuzzle | null> {
  const month = date.toLocaleDateString('en-US', { month: 'long' }).toLowerCase();
  const pageUrl = `https://www.vulture.com/article/daily-crossword-puzzle-${month}-${date.getDate()}-${date.getFullYear()}.html`;

  const headResponse = await fetch(pageUrl, {
    method: 'HEAD',
    headers: { 'User-Agent': USER_AGENT },
  });
  if (headResponse.status === 404) {
    return null;
  }

  const response = await fetch(pageUrl, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`Unable to load ${pageUrl}`);
  }

  const pageHtml = await response.text();
  const solverUrl = findAmuseLabsEmbedUrl(pageHtml, pageUrl);
  if (!solverUrl) {
    throw new Error(`Can't find AmuseLabs embed on ${pageUrl}`);
  }

  return fetchAmuseLabsPuzzle(solverUrl, {
    publicationId,
    date,
    sourceLink: pageUrl,
  });
}

export class VultureSource implements PuzzleSource {
  public id = 'Vulture';
  public name = 'Vulture';

  public getPuzzle(date: Date) {
    return fetchVulturePuzzle(date, this.id as PublicationId);
  }
}
