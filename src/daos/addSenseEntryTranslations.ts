import { sqlQuery } from "./postgres";

export interface SenseEntryTranslationData {
  sense_id: string;
  entry: string;
  lang: string;
  display_text: string;
}

export const addSenseEntryTranslations = async (translations: SenseEntryTranslationData[]): Promise<void> => {
  if (translations.length === 0) {
    return;
  }

  await sqlQuery(true, "add_sense_entry_translations", [
    { name: "p_translations", value: translations },
  ]);
};
