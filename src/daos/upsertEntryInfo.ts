import { sqlQuery } from "./postgres";
import { Sense } from "../models/Sense";

export const getSensesForEntry = async (entry: string, lang: string): Promise<Sense[]> => {
  const results = await sqlQuery(true, "get_senses_for_entry", [
    { name: "p_entry", value: entry },
    { name: "p_lang", value: lang },
  ]);

  return results.map((row: any) => ({
    id: row.id,
    partOfSpeech: row.part_of_speech,
    commonness: row.commonness,
    summary: row.summary ? new Map(Object.entries(row.summary)) : undefined,
    definition: row.definition ? new Map(Object.entries(row.definition)) : undefined,
    exampleSentences: row.example_sentences || [],
    translations: row.translations ? new Map(Object.entries(row.translations)) : undefined,
    sourceAi: row.source_ai,
  } as Sense));
};

export const upsertEntryInfo = async (
  entry: string,
  lang: string,
  senses: Sense[],
  status: 'Ready' | 'Error' | 'Invalid'
): Promise<void> => {
  // Convert senses to the format expected by the stored procedure
  const sensesData = senses.map(sense => ({
    id: sense.id,
    part_of_speech: sense.partOfSpeech,
    commonness: sense.commonness,
    summary: sense.summary?.get(lang),
    definition: sense.definition?.get(lang),
    source_ai: sense.sourceAi,
    ...(sense as any).corresponds_with && { corresponds_with: (sense as any).corresponds_with },
  }));

  // Create single jsonb parameter
  const entryInfoData = {
    entry,
    lang,
    senses: sensesData,
    status,
  };

  await sqlQuery(true, "upsert_entry_info", [
    { name: "p_entry_info", value: JSON.stringify(entryInfoData) },
  ]);
};
