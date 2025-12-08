import { sqlQuery } from "./postgres";

export interface EntryInsertData {
  entry: string;
  lang: string;
  length: number;
  display_text: string;
}

export const insertEntries = async (entries: EntryInsertData[]): Promise<void> => {
  if (entries.length === 0) {
    return;
  }

  await sqlQuery(true, "insert_entries", [
    { name: "p_entries", value: entries },
  ]);
};
