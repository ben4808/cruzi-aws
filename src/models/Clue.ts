import { ClueProgressData } from "./ClueProgressData";
import { Entry } from "./Entry";
import { Sense } from "./Sense";

export interface Clue {
    id?: string;
    entry: Entry;
    lang: string;
    sense?: Sense; // if linked to a specific Sense
    customClue?: string;
    customDisplayText?: string;
    progressData?: ClueProgressData;

    // related to the Clue Collection it's in
    order?: number;
    metadata1?: string;
    metadata2?: string;
};
