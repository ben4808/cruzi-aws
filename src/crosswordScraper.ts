import { generatePuzFile } from './lib/puzFiles';
import { processPuzData } from './lib/puzFiles';
import { Puzzle } from './models/Puzzle';
import { PuzzleSource, PuzzleSources } from './models/PuzzleSource';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { GeminiAiProvider } from './ai/gemini';
import { IAiProvider } from './ai/IAiProvider';
import { ILoaderDao } from './daos/ILoaderDao';
import LoaderDao from './daos/LoaderDao';
import { arrayToMap, generateId, mapValues } from './lib/utils';
import { Clue } from './models/Clue';
import { ClueCollection } from './models/ClueCollection';
import { Entry } from './models/Entry';
import { FamiliarityResult } from './models/FamiliarityResult';
import { QualityResult } from './models/QualityResult';
import fs from 'fs';

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

async function uploadPuzzleToS3(puzzle: Puzzle, key: string): Promise<void> {
  const blob = generatePuzFile(puzzle);
  const buffer = Buffer.from(await blob.arrayBuffer());
  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'application/octet-stream',
  }));
  console.log(`Uploaded ${key} to s3://${S3_BUCKET}/`);
}

export const scrapePuzzles = async (): Promise<Puzzle[]> => {
  let scrapedPuzzles = [] as Puzzle[]
  let sources = [
    PuzzleSources.NYT, 
    PuzzleSources.WSJ, 
    PuzzleSources.Newsday
  ] as PuzzleSource[]; // Add other sources as needed
  let date = new Date(); // Use today's date or modify as needed

  await Promise.all(sources.map(async (source) => {
    try {
        let puzzle = await scrapePuzzle(source, date);
        scrapedPuzzles.push(puzzle);

        let key = `${source.id}-${date.toISOString().split('T')[0]}.puz`;
        await uploadPuzzleToS3(puzzle, key);

        console.log(`Scraped puzzle from ${source.name} for date ${date.toISOString()}`);
    } catch (error) {
        console.error(`Error scraping puzzle from ${source.name} for date ${date.toISOString()}: `, error);
    }
  }));

  return scrapedPuzzles;
}

let dao: ILoaderDao = new LoaderDao();
let aiProvider: IAiProvider = new GeminiAiProvider();
let useMockData = true; // Set to true to use mock data for testing

let runCrosswordLoadingTasks = async () => {
  let scrapedPuzzles = [] as Puzzle[];

  console.log("Starting crossword loading tasks...");
  try {
    if (useMockData)
      scrapedPuzzles = await getSamplePuzzles();
    else
      scrapedPuzzles = await scrapePuzzles();

    await Promise.all(scrapedPuzzles.map(async (puzzle) => {
      await processPuzzle(puzzle);
    }));

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
      // These will be reset by the new average later.
      for (let entry of entries) {
        entry.familiarityScore = undefined;
        entry.qualityScore = undefined;
      }
      
      let entriesMap: Map<string, Entry> = arrayToMap(entries, entry => entry.entry);
      let lang = puzzle.lang || 'en';

      let familiarityResults = await aiProvider.getFamiliarityResultsAsync(entries, lang, useMockData);
      populateEntryFamiliarityInfo(entriesMap, familiarityResults);
      let qualityResults = await aiProvider.getQualityResultsAsync(entries, lang, useMockData);
      populateEntryQualityInfo(entriesMap, qualityResults);

      await dao.saveClueCollection(clueCollection); // Adds id to collection
      await dao.addCluesToCollection(clueCollection.id!, clueCollection.lang, clueCollection.clues!);
      await dao.addEntries(entries);
      await dao.addFamiliarityQualityResults(entries, aiProvider.sourceAI);

      console.log(`${puzzle.publication} scores saved.`);
  } catch (error) {
    console.error(`Error processing puzzle ${puzzle.publication}`, error);
  }
}

let puzzleToClueCollection = (puzzle: Puzzle): ClueCollection => {
  let lang = puzzle.lang || 'en';

  let clues: Clue[] = mapValues(puzzle.entries).map(puzEntry => ({
    id: generateId(),
    entry: {
      entry: puzEntry.entry,
      lang: lang,
    },
    customClue: puzEntry.clue,
    source: "cw",
  }));

  let clueCollection: ClueCollection = {
    puzzle: puzzle,
    title: puzzle.title,
    lang: lang,
    createdDate: new Date(),
    modifiedDate: new Date(),
    source: puzzle.publication || "unknown",
    isCrosswordCollection: true,
    isPrivate: false,
    clueCount: clues.length,
    clues: clues,
  };

  return clueCollection;
}

let populateEntryFamiliarityInfo = (entriesMap: Map<string, Entry>, FamiliarityResults: FamiliarityResult[]) => {
  FamiliarityResults.forEach(result => {
    let entry = entriesMap.get(result.entry);
    if (entry) {
      entry.rootEntry = result.baseForm;
      entry.displayText = result.displayText;
      entry.entryType = result.entryType;
      entry.familiarityScore = result.familiarityScore;
    } else {
      console.warn(`Entry not found for Familiarity result: ${result.entry}`);
    }
  });
}

let populateEntryQualityInfo = (entriesMap: Map<string, Entry>, qualityResults: QualityResult[]) => {
  qualityResults.forEach(result => {
    let entry = entriesMap.get(result.entry);
    if (entry) {
      entry.qualityScore = result.qualityScore;
    } else {
      console.warn(`Entry not found for Familiarity result: ${result.entry}`);
    }
  });
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
