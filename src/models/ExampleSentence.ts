export interface ExampleSentence {
  id?: string;
  senseId: string;
  translations?: Map<string, string>; // <lang, translation of the example sentence>
  source_ai?: string; // Source of the translation (e.g., "Google Translate", "DeepL")
}
