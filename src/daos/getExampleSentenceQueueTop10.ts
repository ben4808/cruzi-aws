import { sqlQuery } from "./postgres";

export interface ExampleSentenceQueueItem {
  sense_id: string;
  entry: string;
  display_text: string;
  lang: string;
  sense_summary: string;
}

const getExampleSentenceQueueTop10 = async (): Promise<ExampleSentenceQueueItem[]> => {
  const results = await sqlQuery(true, "get_example_sentence_queue_top_10", []);

  return results.map(row => ({
    sense_id: row.sense_id,
    entry: row.entry,
    display_text: row.display_text,
    lang: row.lang,
    sense_summary: row.sense_summary,
  }));
};

export default getExampleSentenceQueueTop10;
