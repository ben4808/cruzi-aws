import { Entry } from "../models/Entry";
import { FamiliarityResult } from "../models/FamiliarityResult";
import { QualityResult } from "../models/QualityResult";

export interface IAiProvider {
    sourceAI: string;

    getFamiliarityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<FamiliarityResult[]>;
    getQualityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<QualityResult[]>;

    generateResultsAsync(prompt: string): Promise<string>;
}
