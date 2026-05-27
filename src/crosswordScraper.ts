/**
 * This file contains the code for the crossword scraper lambda function.
 * It is responsible for scraping crossword puzzles from the web and saving them to a storage drive.
 * It also creates a new crossword and clue collection in the database for the crossword.
 * It then enqueues all answers into the entry info queue to have its senses (definitions) populated.
 */

import { generatePuzFile } from './lib/puzFiles';
import { processPuzData } from './lib/puzFiles';
import {
  ClueCollection,
  CollectionClue,
  Puzzle,
  ScrapedPuzzle,
} from 'cruzi-models';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ILoaderDao, LoaderDao } from 'cruzi-db';
import { generateId, mapValues } from './lib/utils';
import { PuzzleSource, PuzzleSources } from './scraper/PuzzleSource';
import fs from 'fs';
import path from 'path';

const crosswordsToScrape = [
  { source: PuzzleSources.NYT, date: new Date('2026-05-27') },
  { source: PuzzleSources.WSJ, date: new Date('2026-05-27') },
  { source: PuzzleSources.Newsday, date: new Date('2026-05-27') },
] as { source: PuzzleSource, date: Date }[];

let scrapePuzzle = async (source: PuzzleSource, date: Date): Promise<ScrapedPuzzle> => {
  try {
    let puzzle = await source.getPuzzle(date);
    return puzzle;
  } catch (error) {
    throw error; // Re-throw to handle it in the calling function
  }
}

const S3_BUCKET = 'scraped-crosswords';
const s3Client = new S3Client({});
const LOCAL_PUZ_PATH = 'C:\\Users\\ben_z\\Desktop\\puzzles';

async function puzzleToBuffer(puzzle: ScrapedPuzzle): Promise<Buffer> {
  const blob = generatePuzFile(puzzle);
  return Buffer.from(await blob.arrayBuffer());
}

async function uploadPuzzleToS3(puzzle: ScrapedPuzzle, key: string): Promise<void> {
  const buffer = await puzzleToBuffer(puzzle);
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'application/octet-stream',
  }));
  console.log(`Uploaded ${key} to s3://${S3_BUCKET}/`);
}

async function savePuzzleToLocal(puzzle: ScrapedPuzzle, key: string): Promise<void> {
  const buffer = await puzzleToBuffer(puzzle);
  await fs.promises.mkdir(LOCAL_PUZ_PATH, { recursive: true });
  const localFilePath = path.join(LOCAL_PUZ_PATH, key);
  await fs.promises.writeFile(localFilePath, buffer);
  console.log(`Saved ${key} to ${localFilePath}`);
}

async function savePuzzle(puzzle: ScrapedPuzzle, key: string): Promise<void> {
  const puzLocation = process.env.PUZ_LOCATION;

  if (puzLocation === 'S3') {
    await uploadPuzzleToS3(puzzle, key);
    return;
  }

  if (puzLocation === 'local') {
    await savePuzzleToLocal(puzzle, key);
    return;
  }

  console.log(`Skipping save for ${key}; PUZ_LOCATION is not set to 'S3' or 'local'.`);
}

export const scrapePuzzles = async (): Promise<ScrapedPuzzle[]> => {
  let scrapedPuzzles = [] as ScrapedPuzzle[]

  await Promise.all(crosswordsToScrape.map(async (crossword) => {
    try {
        let dateString = crossword.date.toISOString().split('T')[0];
        let puzzle = await scrapePuzzle(crossword.source, crossword.date);
        scrapedPuzzles.push(puzzle);
        
        let key = `${crossword.source.id}-${dateString}.puz`;
        await savePuzzle(puzzle, key);

        console.log(`Scraped puzzle from ${crossword.source.name} for date ${crossword.date.toISOString()}`);
    } catch (error) {
        console.error(`Error scraping puzzle from ${crossword.source.name} for date ${crossword.date.toISOString()}: `, error);
    }
  }));

  return scrapedPuzzles;
}

let dao: ILoaderDao = new LoaderDao();
let useMockData = false; // Set to true to use mock data for testing

let runCrosswordLoadingTasks = async () => {
  let scrapedPuzzles = [] as ScrapedPuzzle[];

  console.log("Starting crossword loading tasks...");
  try {
    if (useMockData)
      scrapedPuzzles = await getSamplePuzzles();
    else
      scrapedPuzzles = await scrapePuzzles();

    // Process puzzles sequentially so DB work does not run in parallel. Overlapping
    // transactions on shared rows (e.g. entries, queues) can deadlock when lock
    // order differs between workers.
    for (const puzzle of scrapedPuzzles) {
      await processPuzzle(puzzle);
    }

  } catch (error) {
    console.error("Error in crossword loading tasks: ", error);
  }
};

let processPuzzle = async (puzzle: ScrapedPuzzle): Promise<void> => {
  try {
      console.log(`Processing puzzle for ${puzzle.publicationId}`);
      await dao.savePuzzle(puzzle);
      puzzle.id = puzzle.id;
      let clueCollection = puzzleToClueCollection(puzzle);

      console.log(`${puzzle.publicationId} clues extracted: ${clueCollection.clues!.length}`);

      let entries = (clueCollection.clues as CollectionClue[]).map(c => c.clue.entry);
      let uniqueEntries = Array.from(new Set(entries.map(entry => entry.entry))).sort(
        (a, b) => (a === b ? 0 : a < b ? -1 : 1),
      );
      let familiarityQueueItems = uniqueEntries.map(entry => ({
        entry,
        lang: puzzle.lang || 'en',
      }));

      await dao.saveClueCollection(clueCollection); // Adds id to collection
      await dao.addCluesToCollection(clueCollection.id!, clueCollection.clues as CollectionClue[]);
      await dao.upsertEntries(familiarityQueueItems);
      await dao.addCrosswordFamiliarityQueueEntries(familiarityQueueItems);

      console.log(`${puzzle.publicationId} entry info queued.`);
  } catch (error) {
    console.error(`Error processing puzzle ${puzzle.publicationId}`, error);
  }
}

let puzzleToClueCollection = (puzzle: ScrapedPuzzle): ClueCollection => {
  let lang = puzzle.lang || 'en';

  let clues: CollectionClue[] = mapValues(puzzle.entries).map((puzEntry, index) => ({
    clue: {
      id: generateId(),
      lang,
      entry: {
        entry: puzEntry.entry,
        lang: lang,
      },
      customClue: puzEntry.clue,
      source: puzzle.publicationId || "unknown",
    },
    order: index,
    metadata1: puzEntry.index,
  }));

  let clueCollection: ClueCollection = {
    puzzle: puzzle as Puzzle,
    title: puzzle.title,
    lang: lang,
    author: puzzle.authors?.join(", "),
    createdDate: new Date(),
    modifiedDate: new Date(),
    source: puzzle.publicationId || "unknown",
    isPrivate: false,
    clueCount: clues.length,
    clueCount6Plus: clues.filter(c => c.clue.entry.entry.length >= 6).length,
    clues: clues,
    aiCompositeScore: puzzle.date.toISOString().split('T')[0],
  };

  return clueCollection;
}

let getSamplePuzzles = async (): Promise<ScrapedPuzzle[]> => {
  let buffer = await loadSamplePuzAsync();
  let puzzle = await processPuzData(new Blob([new Uint8Array(buffer)], { type: 'application/octet-stream' }));
  puzzle!.publicationId = "NYT";
  puzzle!.lang = "en";
  return [puzzle!];
}

async function loadSamplePuzAsync(): Promise<Buffer> {
  try {
    const content: Buffer = await fs.promises.readFile('./NYT-2025-07-12.puz');
    return content;
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
}

export const runTasks = runCrosswordLoadingTasks;
