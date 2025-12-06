import { ILoaderDao } from "./ILoaderDao";
import savePuzzle from "./savePuzzle";
import saveClueCollection from "./saveClueCollection";
import addCluesToCollection from "./addCluesToCollection";
import addTranslateResults from "./addTranslateResults";
import addObscurityQualityResults from "./addObscurityQualityResults";
import getEntryInfoQueueTop10 from "./getEntryInfoQueueTop10";
import upsertEntryInfo from "./upsertEntryInfo";
import addExampleSentenceQueueEntry, { addExampleSentenceQueueEntries } from "./addExampleSentenceQueueEntry";

class LoaderDao implements ILoaderDao {
    savePuzzle = savePuzzle;

    saveClueCollection = saveClueCollection;

    addCluesToCollection = addCluesToCollection;

    addTranslateResults = addTranslateResults;

    addObscurityQualityResults = addObscurityQualityResults;

    getEntryInfoQueueTop10 = getEntryInfoQueueTop10;

    upsertEntryInfo = upsertEntryInfo;

    addExampleSentenceQueueEntry = addExampleSentenceQueueEntry;

    addExampleSentenceQueueEntries = addExampleSentenceQueueEntries;
}

export default LoaderDao;
