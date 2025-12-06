import { generatePuzFile } from './lib/puzFiles';
import { processPuzData } from './lib/puzFiles';
import { Puzzle } from './models/Puzzle';
import { PuzzleSource, PuzzleSources } from './models/PuzzleSource';
import { writeFile } from 'fs/promises';
import { GeminiAiProvider } from './ai/gemini';
import { IAiProvider } from './ai/IAiProvider';
import { ILoaderDao } from './daos/ILoaderDao';
import LoaderDao from './daos/LoaderDao';
import { arrayToMap, generateId, mapValues } from './lib/utils';
import { Clue } from './models/Clue';
import { ClueCollection } from './models/ClueCollection';
import { Entry } from './models/Entry';
import { ObscurityResult } from './models/ObscurityResult';
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

let savePuzzle = async (puzzle: Puzzle, directory: string, filename: string): Promise<void> => {
  let filePath = `${directory}\\${filename}`;
  let blob = generatePuzFile(puzzle);
  await writeBlobToFile(blob, filePath);
}

async function writeBlobToFile(blob: Blob, filePath: string): Promise<void> {
  try {
    // Convert Blob to Buffer
    const buffer = Buffer.from(await blob.arrayBuffer());
    await writeFile(filePath, buffer);
    console.log('File written successfully');
  } catch (error) {
    console.error('Error writing file:', error);
  }
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

        let directory = "C:\\Users\\ben_z\\Desktop\\puzzles";
        let fileName = `${source.id}-${date.toISOString().split('T')[0]}.puz`;
        await savePuzzle(puzzle, directory, fileName);

        console.log(`Scraped puzzle from ${source.name} for date ${date.toISOString()}`);
    } catch (error) {
        console.error(`Error scraping puzzle from ${source.name} for date ${date.toISOString()}: `, error);
    }
  }));

  return scrapedPuzzles;
}

let dao: ILoaderDao = new LoaderDao();
let aiProvider: IAiProvider = new GeminiAiProvider();
let mockData = false; // Set to true to use mock data for testing

let runCrosswordLoadingTasks = async () => {
  let scrapedPuzzles = [] as Puzzle[];

  console.log("Starting crossword loading tasks...");
  try {
    if (mockData)
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
      await dao.saveClueCollection(clueCollection);
      await dao.addCluesToCollection(clueCollection.id!, clueCollection.clues!);

      console.log(`${puzzle.publication} clues saved: ${clueCollection.clues!.length}`);

      let entries = clueCollection.clues!.map(clue => clue.entry!);
      let entriesMap: Map<string, Entry> = arrayToMap(entries, entry => entry.entry);

      let originalLang = 'en';
      let translatedLang = "es";

      let translateResults = await aiProvider.getTranslateResultsAsync(clueCollection.clues!, originalLang, translatedLang, mockData);
      await dao.addTranslateResults(translateResults);

      console.log(`${puzzle.publication} translations saved.`);

      let obscurityResults = await aiProvider.getObscurityResultsAsync(entries, translatedLang, mockData);
      populateEntryObscurityInfo(entriesMap, obscurityResults);
      let qualityResults = await aiProvider.getQualityResultsAsync(entries, translatedLang, mockData);
      populateEntryQualityInfo(entriesMap, qualityResults);

      await dao.addObscurityQualityResults(entries, aiProvider.sourceAI);

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

let populateEntryObscurityInfo = (entriesMap: Map<string, Entry>, obscurityResults: ObscurityResult[]) => {
  obscurityResults.forEach(result => {
    let entry = entriesMap.get(result.entry);
    if (entry) {
      entry.displayText = result.displayText;
      entry.entryType = result.entryType;
      entry.familiarityScore = result.obscurityScore;
    } else {
      console.warn(`Entry not found for obscurity result: ${result.entry}`);
    }
  });
}

let populateEntryQualityInfo = (entriesMap: Map<string, Entry>, qualityResults: QualityResult[]) => {
  qualityResults.forEach(result => {
    let entry = entriesMap.get(result.entry);
    if (entry) {
      entry.qualityScore = result.qualityScore;
    } else {
      console.warn(`Entry not found for obscurity result: ${result.entry}`);
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
