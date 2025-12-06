import { Clue } from "../models/Clue";
import { ClueCollection } from "../models/ClueCollection";
import { Entry } from "../models/Entry";
import { Puzzle } from "../models/Puzzle";
import { TranslateResult } from "../models/TranslateResult";
import { Sense } from "../models/Sense";
import { EntryInfoQueueItem } from "./getEntryInfoQueueTop10";

export interface ILoaderDao {
    savePuzzle: (puzzle: Puzzle) => Promise<void>;
    saveClueCollection: (clueCollection: ClueCollection) => Promise<void>;
    addCluesToCollection: (collectionId: string, clues: Clue[]) => Promise<void>;
    addTranslateResults: (translatedResults: TranslateResult[]) => Promise<void>;
    addObscurityQualityResults: (entries: Entry[], sourceAI: string) => Promise<void>;
    getEntryInfoQueueTop10: () => Promise<EntryInfoQueueItem[]>;
    upsertEntryInfo: (entry: string, lang: string, senses: Sense[], status: 'Ready' | 'Error' | 'Invalid') => Promise<void>;
    addExampleSentenceQueueEntries: (senseIds: string[]) => Promise<void>;
    addExampleSentenceQueueEntry: (senseId: string) => Promise<void>;
}
