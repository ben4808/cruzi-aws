import { Entry } from "./Entry";
import { EntryTranslation } from "./EntryTranslation";
import { ExampleSentence } from "./ExampleSentence";

export interface Sense {
  id?: string;
  entry: Entry;
  partOfSpeech?: string;
  commonness?: string;
  familiarityScore?: number;
  qualityScore?: number;
  sourceAi?: string; // Source of the sense (e.g., "ChatGPT", "WordNet")
  summary?: string;
  definition?: string;
  exampleSentences?: ExampleSentence[];
  similarEntries?: Entry[];
  translations?: Map<string, EntryTranslation>; // <lang, EntryTranslation>
}
