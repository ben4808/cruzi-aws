import { sqlQuery } from "./postgres";

export interface EntryInfoQueueItem {
  entry: string;
  display_text: string;
  lang: string;
  existing_sense_summaries: string[];
  example_sentence_count: number;
}

const getEntryInfoQueueTop10 = async (): Promise<EntryInfoQueueItem[]> => {
  const results = await sqlQuery(true, "get_entry_info_queue_top_10", []);

  return results.map(row => ({
    entry: row.entry,
    display_text: row.display_text,
    lang: row.lang,
    existing_sense_summaries: row.existing_sense_summaries || [],
    example_sentence_count: parseInt(row.example_sentence_count) || 0,
  }));
};

export default getEntryInfoQueueTop10;
