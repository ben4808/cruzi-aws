import getCrosswordFamiliarityQueueTop25, { CrosswordFamiliarityQueueItem } from "./daos/getCrosswordFamiliarityQueueTop25";
import addEntries from "./daos/addEntries";
import { addCrosswordQualityQueueEntries } from "./daos/addCrosswordQualityQueueEntries";
import { GeminiAiProvider } from "./ai/gemini";
import { Entry } from "./models/Entry";

const geminiProvider = new GeminiAiProvider();

export async function crosswordFamiliarityGenerator(): Promise<void> {
  try {
    console.log("Starting crossword familiarity generation...");

    const queueItems = await getCrosswordFamiliarityQueueTop25();
    console.log(`Processing ${queueItems.length} entries from crossword familiarity queue`);

    if (queueItems.length === 0) {
      console.log("No entries in crossword familiarity queue");
      return;
    }

    const queueItemsByLang = new Map<string, CrosswordFamiliarityQueueItem[]>();
    for (const item of queueItems) {
      const items = queueItemsByLang.get(item.lang) || [];
      items.push(item);
      queueItemsByLang.set(item.lang, items);
    }

    const entriesToPersist: Entry[] = [];

    for (const [lang, langQueueItems] of queueItemsByLang.entries()) {
      const entriesForLanguage: Entry[] = langQueueItems.map((item) => ({
        entry: item.entry,
        lang: item.lang,
      }));

      console.log(`Requesting familiarity scores for ${entriesForLanguage.length} ${lang} entries`);
      const familiarityResults = await geminiProvider.getFamiliarityResultsAsync(entriesForLanguage, lang, false);

      for (const result of familiarityResults) {
        entriesToPersist.push({
          entry: result.entry,
          lang: result.lang,
          rootEntry: result.baseForm || undefined,
          displayText: result.displayText,
          entryType: result.entryType,
          familiarityScore: result.familiarityScore,
        });
      }
    }

    if (entriesToPersist.length === 0) {
      console.warn("No familiarity results were generated");
      return;
    }

    await addEntries(entriesToPersist);
    console.log(`Updated familiarity fields for ${entriesToPersist.length} entries`);

    const qualityQueueEntries = entriesToPersist.map((entry) => ({
      entry: entry.entry,
      lang: entry.lang,
    }));
    await addCrosswordQualityQueueEntries(qualityQueueEntries);
    console.log(`Queued ${qualityQueueEntries.length} entries in crossword quality queue`);

    console.log("Crossword familiarity generation completed");
  } catch (error) {
    console.error("Fatal error in crosswordFamiliarityGenerator:", error);
    throw error;
  }
}
