import { sqlQuery } from "./postgres";

export interface ExistingSenseInfo {
  id: string;
  summary: string;
}

export interface EntryInfoQueueItem {
  entry: string;
  display_text: string;
  lang: string;
  existing_sense_info: ExistingSenseInfo[];
  example_sentence_count: number;
}

const getEntryInfoQueueTop10 = async (): Promise<EntryInfoQueueItem[]> => {
  const results = await sqlQuery(true, "get_entry_info_queue_top_10", []);

  return results.map(row => {
    const senseIds = row.existing_sense_ids || [];
    const senseSummaries = row.existing_sense_summaries || [];
    const existingSenseInfo: ExistingSenseInfo[] = [];

    // Combine sense IDs and summaries into objects
    for (let i = 0; i < Math.min(senseIds.length, senseSummaries.length); i++) {
      existingSenseInfo.push({
        id: senseIds[i],
        summary: senseSummaries[i]
      });
    }

    return {
      entry: row.entry,
      display_text: row.display_text,
      lang: row.lang,
      existing_sense_info: existingSenseInfo,
      example_sentence_count: parseInt(row.example_sentence_count) || 0,
    };
  });
};

export default getEntryInfoQueueTop10;
