import { getCrosswordQualityQueueTop25, CrosswordQualityQueueItem, getEntries, upsertEntries, addCrosswordQualityQueueEntries } from "cruzi-db";
import { GeminiAiProvider } from "./ai/gemini";
import { Entry } from 'cruzi-models';

const geminiProvider = new GeminiAiProvider();

export async function crosswordQualityGenerator(): Promise<void> {
  let queueItems: CrosswordQualityQueueItem[] = [];

  try {
    console.log("Starting crossword quality generation...");

    queueItems = await getCrosswordQualityQueueTop25();
    console.log(`Processing ${queueItems.length} entries from crossword quality queue`);

    if (queueItems.length === 0) {
      console.log("No entries in crossword quality queue");
      return;
    }

    const dbEntries = await getEntries(queueItems);
    const dbEntriesByKey = new Map<string, Entry>();
    for (const dbEntry of dbEntries) {
      dbEntriesByKey.set(`${dbEntry.entry}|${dbEntry.lang}`, dbEntry as Entry);
    }

    const queueItemsByLang = new Map<string, CrosswordQualityQueueItem[]>();
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
        // Quality prompt expects display text; fall back to raw entry when missing.
        displayText: dbEntriesByKey.get(`${item.entry}|${item.lang}`)?.displayText || item.entry,
      }));

      console.log(`Requesting quality scores for ${entriesForLanguage.length} ${lang} entries`);
      const qualityResults = await geminiProvider.getQualityResultsAsync(entriesForLanguage, lang, false);

      for (const result of qualityResults) {
        entriesToPersist.push({
          entry: result.entry,
          lang: result.lang,
          qualityScore: result.qualityScore,
        });
      }
    }

    if (entriesToPersist.length === 0) {
      console.warn("No quality results were generated");
      try {
        await addCrosswordQualityQueueEntries(queueItems);
        console.log(`Re-queued ${queueItems.length} entries in crossword quality queue after empty results`);
      } catch (requeueError) {
        console.error("Failed to re-queue crossword quality entries after empty results:", requeueError);
      }
      return;
    }

    await upsertEntries(entriesToPersist);
    console.log(`Updated quality fields for ${entriesToPersist.length} entries`);

    console.log("Crossword quality generation completed");
  } catch (error) {
    if (queueItems.length > 0) {
      try {
        await addCrosswordQualityQueueEntries(queueItems);
        console.log(`Re-queued ${queueItems.length} entries in crossword quality queue after failure`);
      } catch (requeueError) {
        console.error("Failed to re-queue crossword quality entries after failure:", requeueError);
      }
    }

    console.error("Fatal error in crosswordQualityGenerator:", error);
    throw error;
  }
}

