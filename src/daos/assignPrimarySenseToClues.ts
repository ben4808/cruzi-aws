import { sqlQuery } from "./postgres";

export const assignPrimarySenseToClues = async (
  entry: string,
  lang: string,
  primarySenseId: string
): Promise<void> => {
  await sqlQuery(true, "assign_primary_sense_to_clues", [
    { name: "p_entry", value: entry },
    { name: "p_lang", value: lang },
    { name: "p_primary_sense_id", value: primarySenseId },
  ]);
};
