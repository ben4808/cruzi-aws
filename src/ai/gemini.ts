import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import * as dotenv from 'dotenv';
import { IAiProvider } from './IAiProvider';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import { getFamiliarityResults, getQualityResults } from './common';

// Load environment variables
dotenv.config();

export type GeminiSourceAi = 'gemini2.5-flash' | 'gemini3-flash' | 'gemini3.1-flash-lite' | 'gemini3.5-flash';

/** Maps app-facing aliases to Google AI `models/{model}` IDs used by @google/genai. */
const GEMINI_API_MODEL_ID: Record<GeminiSourceAi, string> = {
  'gemini2.5-flash': 'gemini-2.5-flash',
  // Gemini 3 Flash is exposed as preview on the Gemini API (see ai.google.dev model docs).
  'gemini3-flash': 'gemini-3-flash-preview',
  'gemini3.1-flash-lite': 'gemini-3.1-flash-lite',
  'gemini3.5-flash': 'gemini-3.5-flash',
};

const GEMINI_35_MODELS = new Set<string>(['gemini-3.5-flash']);

const MAX_GEMINI_ATTEMPTS = 5;

function geminiApiModelId(source: GeminiSourceAi): string {
  return GEMINI_API_MODEL_ID[source];
}

function isRetryableGeminiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(message);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let genAiClient: GoogleGenAI | undefined;

function getGenAiClient(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }

  if (!genAiClient) {
    genAiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  return genAiClient;
}

export class GeminiAiProvider implements IAiProvider {
  sourceAI: GeminiSourceAi;

  constructor(sourceAi: GeminiSourceAi = 'gemini3.5-flash') {
    this.sourceAI = sourceAi;
  }

  async getFamiliarityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<FamiliarityResult[]> {
    return await getFamiliarityResults(this, entries, lang, mockData);
  }

  async getQualityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<QualityResult[]> {
    return await getQualityResults(this, entries, lang, mockData);
  }

  async generateResultsAsync(prompt: string): Promise<string> {
    const model = geminiApiModelId(this.sourceAI);
    const ai = getGenAiClient();
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_GEMINI_ATTEMPTS; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: GEMINI_35_MODELS.has(model)
            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
            : undefined,
        });

        const text = response.text;
        if (!text) {
          throw new Error('Gemini API returned an empty response');
        }

        return text;
      } catch (error) {
        lastError = error;

        if (attempt < MAX_GEMINI_ATTEMPTS && isRetryableGeminiError(error)) {
          const delayMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
          console.warn(
            `Gemini API unavailable for ${model} (attempt ${attempt}/${MAX_GEMINI_ATTEMPTS}), retrying in ${delayMs}ms...`,
          );
          await sleep(delayMs);
          continue;
        }

        console.error('Error calling Gemini API:', error);
        throw new Error(`Failed to generate AI response: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    throw new Error(`Failed to generate AI response: ${lastError instanceof Error ? lastError.message : 'Unknown error'}`);
  }
}
