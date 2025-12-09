import { sqlQuery } from "./postgres";
import { ExampleSentence } from "../models/ExampleSentence";

const addExampleSentences = async (senseId: string, exampleSentences: ExampleSentence[]): Promise<void> => {
  // Convert ExampleSentence array to the format expected by the stored procedure
  const sentencesData = exampleSentences.map(sentence => ({
    translations: sentence.translations ? Object.fromEntries(sentence.translations) : {},
  }));

  await sqlQuery(true, "add_example_sentences", [
    { name: "p_sense_id", value: senseId },
    { name: "p_example_sentences", value: JSON.stringify(sentencesData) },
  ]);
};

export default addExampleSentences;
