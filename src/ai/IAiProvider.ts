import { Clue } from "../models/Clue";
import { Entry } from "../models/Entry";
import { ObscurityResult } from "../models/ObscurityResult";
import { QualityResult } from "../models/QualityResult";
import { TranslateResult } from "../models/TranslateResult";

export interface IAiProvider {
    sourceAI: string;

    getTranslateResultsAsync(clues: Clue[], originalLang: string, translatedLang: string, mockData: boolean): Promise<TranslateResult[]>;
    getObscurityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<ObscurityResult[]>;
    getQualityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<QualityResult[]>;

    generateResultsAsync(prompt: string): Promise<string>;
}
