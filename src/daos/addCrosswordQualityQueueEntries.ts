import { sqlQuery } from "./postgres";
import { EntryInfoQueueItemInput } from "./addEntryInfoQueueEntries";

const addCrosswordQualityQueueEntries = async (items: EntryInfoQueueItemInput[]): Promise<void> => {
  const payload = items.map((i) => ({
    entry: i.entry,
    lang: i.lang,
  }));

  await sqlQuery(true, "add_crossword_quality_queue_entries", [
    { name: "p_entries", value: payload },
  ]);
};

const addCrosswordQualityQueueEntry = async (entry: string, lang: string): Promise<void> => {
  await addCrosswordQualityQueueEntries([{ entry, lang }]);
};

export default addCrosswordQualityQueueEntry;
export { addCrosswordQualityQueueEntries };
