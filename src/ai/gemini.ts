import axios from 'axios';
import * as dotenv from 'dotenv';
import { Clue } from '../models/Clue';
import { IAiProvider } from './IAiProvider';
import { Entry } from '../models/Entry';
import { ObscurityResult } from '../models/ObscurityResult';
import { QualityResult } from '../models/QualityResult';
import { getObscurityResults, getQualityResults, getTranslateResults } from './common';
import { TranslateResult } from '../models/TranslateResult';
import { mock } from 'node:test';

// Load environment variables
dotenv.config();

export class GeminiAiProvider implements IAiProvider {
  sourceAI = 'gemini';

  async getTranslateResultsAsync(clues: Clue[], originalLang: string, translatedLang: string, mockData: boolean): Promise<TranslateResult[]> {
    return await getTranslateResults(this, clues, originalLang, translatedLang, mockData);
  }

  async getObscurityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<ObscurityResult[]> {
    return await getObscurityResults(this, entries, lang, mockData);
  }

  async getQualityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<QualityResult[]> {
    return await getQualityResults(this, entries, lang, mockData);
  }

  async generateResultsAsync(prompt: string): Promise<string> {
    const aiApiHost = process.env.AI_API_HOST;

    if (!aiApiHost) {
      throw new Error('AI_API_HOST environment variable is not set');
    }

    try {
      const response = await axios.post(`${aiApiHost}/api/makeAICall`, {
        prompt: prompt
      }, {
        timeout: 120000 // 2 minutes timeout to match the API
      });

      if (response.data && response.data.success && response.data.response) {
        return response.data.response;
      } else {
        throw new Error('Invalid response from AI API');
      }
    } catch (error) {
      console.error('Error calling AI API:', error);
      throw new Error(`Failed to generate AI response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
