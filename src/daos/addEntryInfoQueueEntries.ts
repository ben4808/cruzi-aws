import { sqlQuery } from "./postgres";

export interface EntryInfoQueueItemInput {
  entry: string;
  lang: string;
}

const addEntryInfoQueueEntries = async (items: EntryInfoQueueItemInput[]): Promise<void> => {
  const payload = items.map((i) => ({
    entry: i.entry,
    lang: i.lang,
  }));
  await sqlQuery(true, "add_entry_info_queue_entries", [{ name: "p_entries", value: payload }]);
};

const addEntryInfoQueueEntry = async (entry: string, lang: string): Promise<void> => {
  await addEntryInfoQueueEntries([{ entry, lang }]);
};

export default addEntryInfoQueueEntry;
export { addEntryInfoQueueEntries };
