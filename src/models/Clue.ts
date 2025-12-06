import { ClueProgressData } from "./ClueProgressData";
import { Entry } from "./Entry";
import { Sense } from "./Sense";

export interface Clue {
    id?: string;
    entry?: Entry;
    sense?: Sense; // if linked to a specific Sense
    progressData?: ClueProgressData;
    customClue?: string;
    customDisplayText?: string;
    customClueTranslations?: Map<string, string>; // <lang, clue>, auxiliary, customClue is canonical
    customEntryTranslations?: Map<string, string>; // <lang, entry>, auxiliary, entry is canonical
    source?: string;  // crossword, book, etc.
};
