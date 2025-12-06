export interface ExampleSentence {
  id?: string;
  senseId: string;
  translations?: Map<string, string>; // <lang, translation of the example sentence>
}
