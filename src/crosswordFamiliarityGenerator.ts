import { getCrosswordFamiliarityQueueTop25, CrosswordFamiliarityQueueItem, upsertEntries, addCrosswordQualityQueueEntries, addCrosswordFamiliarityQueueEntries } from "cruzi-db";
import { GeminiAiProvider } from "./ai/gemini";
import { Entry } from 'cruzi-models';

const geminiProvider = new GeminiAiProvider();

export async function crosswordFamiliarityGenerator(): Promise<void> {
  let queueItems: CrosswordFamiliarityQueueItem[] = [];

  try {
    console.log("Starting crossword familiarity generation...");

    queueItems = await getCrosswordFamiliarityQueueTop25();
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
          baseForm: result.baseForm || undefined,
          displayText: result.displayText,
          entryType: result.entryType,
          familiarityScore: result.familiarityScore,
        });
      }
    }

    if (entriesToPersist.length === 0) {
      console.warn("No familiarity results were generated");
      try {
        await addCrosswordFamiliarityQueueEntries(queueItems);
        console.log(`Re-queued ${queueItems.length} entries in crossword familiarity queue after empty results`);
      } catch (requeueError) {
        console.error("Failed to re-queue crossword familiarity entries after empty results:", requeueError);
      }
      return;
    }

    await upsertEntries(entriesToPersist);
    console.log(`Updated familiarity fields for ${entriesToPersist.length} entries`);

    const qualityQueueEntries = entriesToPersist.map((entry) => ({
      entry: entry.entry,
      lang: entry.lang,
    }));
    await addCrosswordQualityQueueEntries(qualityQueueEntries);
    console.log(`Queued ${qualityQueueEntries.length} entries in crossword quality queue`);

    console.log("Crossword familiarity generation completed");
  } catch (error) {
    if (queueItems.length > 0) {
      try {
        await addCrosswordFamiliarityQueueEntries(queueItems);
        console.log(`Re-queued ${queueItems.length} entries in crossword familiarity queue after failure`);
      } catch (requeueError) {
        console.error("Failed to re-queue crossword familiarity entries after failure:", requeueError);
      }
    }

    console.error("Fatal error in crosswordFamiliarityGenerator:", error);
    throw error;
  }
}
