import { sqlQuery } from "./postgres";

export interface CrosswordQualityQueueItem {
  entry: string;
  lang: string;
}

const getCrosswordQualityQueueTop25 = async (): Promise<CrosswordQualityQueueItem[]> => {
  const results = await sqlQuery(true, "get_crossword_quality_queue_top_25", []);

  return results.map((row) => ({
    entry: row.entry,
    lang: row.lang,
  }));
};

export default getCrosswordQualityQueueTop25;

