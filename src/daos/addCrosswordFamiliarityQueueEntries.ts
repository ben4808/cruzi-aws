import { sqlQuery } from "./postgres";
import { EntryInfoQueueItemInput } from "./addEntryInfoQueueEntries";

const addCrosswordFamiliarityQueueEntries = async (items: EntryInfoQueueItemInput[]): Promise<void> => {
  const payload = items.map((i) => ({
    entry: i.entry,
    lang: i.lang,
  }));

  await sqlQuery(true, "add_crossword_familiarity_queue_entries", [
    { name: "p_entries", value: payload },
  ]);
};

const addCrosswordFamiliarityQueueEntry = async (entry: string, lang: string): Promise<void> => {
  await addCrosswordFamiliarityQueueEntries([{ entry, lang }]);
};

export default addCrosswordFamiliarityQueueEntry;
export { addCrosswordFamiliarityQueueEntries };
