import { Entry } from "../models/Entry";
import { sqlQuery } from "./postgres";

export interface GetEntriesInput {
  entry: string;
  lang: string;
}

const getEntries = async (items: GetEntriesInput[]): Promise<Entry[]> => {
  if (items.length === 0) {
    return [];
  }

  const payload = items.map((item) => ({
    entry: item.entry,
    lang: item.lang,
  }));

  const rows = await sqlQuery(true, "get_entries", [{ name: "p_entries", value: payload }]);
  return rows.map((row) => ({
    entry: row.entry,
    lang: row.lang,
    rootEntry: row.root_entry ?? undefined,
    displayText: row.display_text ?? undefined,
    entryType: row.entry_type ?? undefined,
    familiarityScore: row.familiarity_score ?? undefined,
    qualityScore: row.quality_score ?? undefined,
    crosswordScore: row.crossword_score ?? undefined,
    loadingStatus: row.loading_status ?? undefined,
  }));
};

export default getEntries;
