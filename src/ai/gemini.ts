import { GoogleGenerativeAI } from '@google/generative-ai';
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
  static genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
  static model = GeminiAiProvider.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
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
    const result = await GeminiAiProvider.model.generateContent(prompt);
    const response = await result.response;

    return response.text();
  }
}
