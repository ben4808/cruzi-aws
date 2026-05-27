import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';

export interface IAiProvider {
    sourceAI: string;

    getFamiliarityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<FamiliarityResult[]>;
    getQualityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<QualityResult[]>;

    generateResultsAsync(prompt: string): Promise<string>;
}
