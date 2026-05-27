import { GoogleGenerativeAI } from '@google/generative-ai';
import * as dotenv from 'dotenv';
import { IAiProvider } from './IAiProvider';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import { getFamiliarityResults, getQualityResults } from './common';

// Load environment variables
dotenv.config();

export type GeminiSourceAi = 'gemini2.5-flash' | 'gemini3-flash' | 'gemini3.1-flash-lite';

/** Maps app-facing aliases to Google AI `models/{model}` IDs used by @google/generative-ai. */
const GEMINI_API_MODEL_ID: Record<GeminiSourceAi, string> = {
  'gemini2.5-flash': 'gemini-2.5-flash',
  // Gemini 3 Flash is exposed as preview on the Gemini API (see ai.google.dev model docs).
  'gemini3-flash': 'gemini-3-flash-preview',
  'gemini3.1-flash-lite': 'gemini-3.1-flash-lite',
};

function geminiApiModelId(source: GeminiSourceAi): string {
  return GEMINI_API_MODEL_ID[source];
}

export class GeminiAiProvider implements IAiProvider {
  sourceAI: GeminiSourceAi;

  constructor(sourceAi: GeminiSourceAi = 'gemini3-flash') {
    this.sourceAI = sourceAi;
  }

  async getFamiliarityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<FamiliarityResult[]> {
    return await getFamiliarityResults(this, entries, lang, mockData);
  }

  async getQualityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<QualityResult[]> {
    return await getQualityResults(this, entries, lang, mockData);
  }

  async generateResultsAsync(prompt: string): Promise<string> {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    try {
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: geminiApiModelId(this.sourceAI) });

      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error('Error calling Gemini API:', error);
      throw new Error(`Failed to generate AI response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
