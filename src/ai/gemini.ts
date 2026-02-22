import axios from 'axios';
import * as dotenv from 'dotenv';
import { IAiProvider } from './IAiProvider';
import { Entry } from '../models/Entry';
import { FamiliarityResult } from '../models/FamiliarityResult';
import { QualityResult } from '../models/QualityResult';
import { getFamiliarityResults, getQualityResults } from './common';

// Load environment variables
dotenv.config();

export class GeminiAiProvider implements IAiProvider {
  sourceAI = 'gemini2.5-flash';

  async getFamiliarityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<FamiliarityResult[]> {
    return await getFamiliarityResults(this, entries, lang, mockData);
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
