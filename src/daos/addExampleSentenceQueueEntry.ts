import { sqlQuery } from "./postgres";

const addExampleSentenceQueueEntry = async (senseId: string): Promise<void> => {
  await sqlQuery(true, "add_example_sentence_queue_entries", [
    { name: "p_sense_ids", value: [senseId] },
  ]);
};

const addExampleSentenceQueueEntries = async (senseIds: string[]): Promise<void> => {
  await sqlQuery(true, "add_example_sentence_queue_entries", [
    { name: "p_sense_ids", value: senseIds },
  ]);
};

export default addExampleSentenceQueueEntry;
export { addExampleSentenceQueueEntries };
