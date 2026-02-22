import { ILoaderDao } from "./ILoaderDao";
import savePuzzle from "./savePuzzle";
import saveClueCollection from "./saveClueCollection";
import addCluesToCollection from "./addCluesToCollection";
import addTranslateResults from "./addTranslateResults";
import addEntries from "./addEntries";
import addFamiliarityQualityResults from "./addFamiliarityQualityResults";
import getEntryInfoQueueTop10 from "./getEntryInfoQueueTop10";
import addExampleSentenceQueueEntry, { addExampleSentenceQueueEntries } from "./addExampleSentenceQueueEntry";
import { upsertEntryInfo } from "./upsertEntryInfo";

class LoaderDao implements ILoaderDao {
    savePuzzle = savePuzzle;

    saveClueCollection = saveClueCollection;

    addCluesToCollection = addCluesToCollection;

    addTranslateResults = addTranslateResults;

    addEntries = addEntries;

    addFamiliarityQualityResults = addFamiliarityQualityResults;

    getEntryInfoQueueTop10 = getEntryInfoQueueTop10;

    upsertEntryInfo = upsertEntryInfo;

    addExampleSentenceQueueEntry = addExampleSentenceQueueEntry;

    addExampleSentenceQueueEntries = addExampleSentenceQueueEntries;
}

export default LoaderDao;
