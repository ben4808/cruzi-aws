import { sqlQuery } from "./postgres";

export interface CrosswordFamiliarityQueueItem {
  entry: string;
  lang: string;
}

const getCrosswordFamiliarityQueueTop25 = async (): Promise<CrosswordFamiliarityQueueItem[]> => {
  const results = await sqlQuery(true, "get_crossword_familiarity_queue_top_25", []);

  return results.map((row) => ({
    entry: row.entry,
    lang: row.lang,
  }));
};

export default getCrosswordFamiliarityQueueTop25;
