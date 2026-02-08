import { sqlQuery } from "./postgres";

export interface EntryKey {
  entry: string;
  lang: string;
}

export const updateEntriesLoadingStatus = async (
  entries: EntryKey[],
  status: 'Ready' | 'Processing' | 'Error' | 'Invalid'
): Promise<void> => {
  if (entries.length === 0) {
    return;
  }

  await sqlQuery(true, "update_entries_loading_status", [
    { name: "p_entries", value: JSON.stringify(entries) },
    { name: "p_status", value: status },
  ]);
};