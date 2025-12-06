import { EntryTranslation } from "./EntryTranslation";
import { ExampleSentence } from "./ExampleSentence";

export interface Sense {
  id?: string;
  partOfSpeech?: string;
  commonness?: string;
  summary?: Map<string, string>; // <lang, summary>
  definition?: Map<string, string>; // <lang, definition>
  exampleSentences?: ExampleSentence[];
  translations?: Map<string, EntryTranslation>; // <lang, EntryTranslation>
  familiarityScore?: number;
  qualityScore?: number;
  sourceAi?: string; // Source of the sense (e.g., "ChatGPT", "WordNet")
}
