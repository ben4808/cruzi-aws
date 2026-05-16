/**
 * This file contains the code for the crossword scraper lambda function.
 * It is responsible for scraping crossword puzzles from the web and saving them to a storage drive.
 * It also creates a new crossword and clue collection in the database for the crossword.
 * It then enqueues all answers into the entry info queue to have its senses (definitions) populated.
 */

import { generatePuzFile } from './lib/puzFiles';
import { processPuzData } from './lib/puzFiles';
import { Puzzle } from './models/Puzzle';
import { PuzzleSource, PuzzleSources } from './models/PuzzleSource';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ILoaderDao } from './daos/ILoaderDao';
import LoaderDao from './daos/LoaderDao';
import { generateId, mapValues } from './lib/utils';
import { Clue } from './models/Clue';
import { ClueCollection } from './models/ClueCollection';
import fs from 'fs';
import path from 'path';

let scrapePuzzle = async (source: PuzzleSource, date: Date): Promise<Puzzle> => {
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

async function puzzleToBuffer(puzzle: Puzzle): Promise<Buffer> {
  const blob = generatePuzFile(puzzle);
  return Buffer.from(await blob.arrayBuffer());
}

async function uploadPuzzleToS3(puzzle: Puzzle, key: string): Promise<void> {
  const buffer = await puzzleToBuffer(puzzle);
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'application/octet-stream',
  }));
  console.log(`Uploaded ${key} to s3://${S3_BUCKET}/`);
}

async function savePuzzleToLocal(puzzle: Puzzle, key: string): Promise<void> {
  const buffer = await puzzleToBuffer(puzzle);
  await fs.promises.mkdir(LOCAL_PUZ_PATH, { recursive: true });
  const localFilePath = path.join(LOCAL_PUZ_PATH, key);
  await fs.promises.writeFile(localFilePath, buffer);
  console.log(`Saved ${key} to ${localFilePath}`);
}

async function savePuzzle(puzzle: Puzzle, key: string): Promise<void> {
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

export const scrapePuzzles = async (): Promise<Puzzle[]> => {
  let scrapedPuzzles = [] as Puzzle[]
  let sources = [
    PuzzleSources.NYT, 
    PuzzleSources.WSJ, 
    PuzzleSources.Newsday,
  ] as PuzzleSource[]; // Add other sources as needed
  let date = new Date(); // Use today's date or modify as needed

  await Promise.all(sources.map(async (source) => {
    try {
        let dateString = date.toISOString().split('T')[0];
        let puzzle = await scrapePuzzle(source, date);
        scrapedPuzzles.push(puzzle);
        
        let key = `${source.id}-${dateString}.puz`;
        await savePuzzle(puzzle, key);

        console.log(`Scraped puzzle from ${source.name} for date ${date.toISOString()}`);
    } catch (error) {
        console.error(`Error scraping puzzle from ${source.name} for date ${date.toISOString()}: `, error);
    }
  }));

  return scrapedPuzzles;
}

let dao: ILoaderDao = new LoaderDao();
let useMockData = false; // Set to true to use mock data for testing

let runCrosswordLoadingTasks = async () => {
  let scrapedPuzzles = [] as Puzzle[];

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

let processPuzzle = async (puzzle: Puzzle): Promise<void> => {
  try {
      console.log(`Processing puzzle for ${puzzle.publication}`);
      await dao.savePuzzle(puzzle);
      let clueCollection = puzzleToClueCollection(puzzle);

      console.log(`${puzzle.publication} clues extracted: ${clueCollection.clues!.length}`);

      let entries = clueCollection.clues!.map(clue => clue.entry!);
      let uniqueEntries = Array.from(new Set(entries.map(entry => entry.entry))).sort(
        (a, b) => (a === b ? 0 : a < b ? -1 : 1),
      );
      let familiarityQueueItems = uniqueEntries.map(entry => ({
        entry,
        lang: puzzle.lang || 'en',
      }));

      await dao.saveClueCollection(clueCollection); // Adds id to collection
      await dao.addCluesToCollection(clueCollection.id!, clueCollection.clues!);
      await dao.upsertEntries(familiarityQueueItems);
      await dao.addCrosswordFamiliarityQueueEntries(familiarityQueueItems);

      console.log(`${puzzle.publication} entry info queued.`);
  } catch (error) {
    console.error(`Error processing puzzle ${puzzle.publication}`, error);
  }
}

let puzzleToClueCollection = (puzzle: Puzzle): ClueCollection => {
  let lang = puzzle.lang || 'en';

  let clues: Clue[] = mapValues(puzzle.entries).map(puzEntry => ({
    id: generateId(),
    lang,
    entry: {
      entry: puzEntry.entry,
      lang: lang,
    },
    customClue: puzEntry.clue,
    metadata1: puzEntry.index,
  }));

  let clueCollection: ClueCollection = {
    puzzle: puzzle,
    title: puzzle.title,
    lang: lang,
    author: puzzle.authors?.join(", "),
    createdDate: new Date(),
    modifiedDate: new Date(),
    source: puzzle.publication || "unknown",
    isPrivate: false,
    clueCount: clues.length,
    clues: clues,
    metadata1: puzzle.date.toISOString().split('T')[0],
  };

  return clueCollection;
}

let getSamplePuzzles = async (): Promise<Puzzle[]> => {
  let buffer = await loadSamplePuzAsync();
  let puzzle = await processPuzData(new Blob([new Uint8Array(buffer)], { type: 'application/octet-stream' }));
  puzzle!.publication = "NYT";
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
