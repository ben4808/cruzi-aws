import { ILoaderDao } from "./ILoaderDao";
import savePuzzle from "./savePuzzle";
import saveClueCollection from "./saveClueCollection";
import addCluesToCollection from "./addCluesToCollection";
import addTranslateResults from "./addTranslateResults";
import upsertEntries from "./upsertEntries";
import addFamiliarityQualityResults from "./addFamiliarityQualityResults";
import getEntryInfoQueueTop10 from "./getEntryInfoQueueTop10";
import addExampleSentenceQueueEntry, { addExampleSentenceQueueEntries } from "./addExampleSentenceQueueEntry";
import addEntryInfoQueueEntry, { addEntryInfoQueueEntries } from "./addEntryInfoQueueEntries";
import addCrosswordFamiliarityQueueEntry, { addCrosswordFamiliarityQueueEntries } from "./addCrosswordFamiliarityQueueEntries";
import addCrosswordQualityQueueEntry, { addCrosswordQualityQueueEntries } from "./addCrosswordQualityQueueEntries";
import { upsertEntryInfo } from "./upsertEntryInfo";

class LoaderDao implements ILoaderDao {
    savePuzzle = savePuzzle;

    saveClueCollection = saveClueCollection;

    addCluesToCollection = addCluesToCollection;

    addTranslateResults = addTranslateResults;

    upsertEntries = upsertEntries;

    addFamiliarityQualityResults = addFamiliarityQualityResults;

    getEntryInfoQueueTop10 = getEntryInfoQueueTop10;

    upsertEntryInfo = upsertEntryInfo;

    addExampleSentenceQueueEntry = addExampleSentenceQueueEntry;

    addExampleSentenceQueueEntries = addExampleSentenceQueueEntries;

    addEntryInfoQueueEntry = addEntryInfoQueueEntry;

    addEntryInfoQueueEntries = addEntryInfoQueueEntries;

    addCrosswordFamiliarityQueueEntry = addCrosswordFamiliarityQueueEntry;

    addCrosswordFamiliarityQueueEntries = addCrosswordFamiliarityQueueEntries;

    addCrosswordQualityQueueEntry = addCrosswordQualityQueueEntry;

    addCrosswordQualityQueueEntries = addCrosswordQualityQueueEntries;
}

export default LoaderDao;
