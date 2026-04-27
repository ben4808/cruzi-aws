import { Sense } from "./Sense";

export interface Entry {
    entry: string;
    lang: string;
    rootEntry?: string; // for inflected forms
    displayText?: string;
    entryType?: string;
    avgFamiliarityScore?: number;
    avgQualityScore?: number;
    cruziScore?: number;
    loadingStatus?: string; // Unprocessed, Ready, Processing, Invalid

    senses?: Map<string, Sense>; // <senseId, Sense>
    tags?: Map<string, string>; // <tag, value>
}
