import { Entry } from "./Entry";

export interface EntryTranslation {
    naturalTranslations?: Entry[]; 
    colloquialTranslations?: Entry[]; 
    alternatives?: Entry[];
    source_ai?: string; // Source of the translation (e.g., "Google Translate", "DeepL")
}
