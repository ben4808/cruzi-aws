import axios from 'axios';
import * as dotenv from 'dotenv';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import { getFamiliarityResults, getQualityResults } from './common';
import { IAiProvider } from './IAiProvider';

dotenv.config();

export type GrokSourceAi = 'grok-4.3';

const GROK_API_MODEL_ID: Record<GrokSourceAi, string> = {
  'grok-4.3': 'grok-4.3',
};

const GROK_API_BASE_URL = 'https://api.x.ai/v1';

function grokApiModelId(source: GrokSourceAi): string {
  return GROK_API_MODEL_ID[source];
}

export class GrokAiProvider implements IAiProvider {
  sourceAI: GrokSourceAi;

  constructor(sourceAi: GrokSourceAi = 'grok-4.3') {
    this.sourceAI = sourceAi;
  }

  async getFamiliarityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<FamiliarityResult[]> {
    return await getFamiliarityResults(this, entries, lang, mockData);
  }

  async getQualityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<QualityResult[]> {
    return await getQualityResults(this, entries, lang, mockData);
  }

  async generateResultsAsync(prompt: string): Promise<string> {
    if (!process.env.GROK_API_KEY) {
      throw new Error('GROK_API_KEY environment variable is not set');
    }

    try {
      const response = await axios.post(
        `${GROK_API_BASE_URL}/chat/completions`,
        {
          model: grokApiModelId(this.sourceAI),
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.GROK_API_KEY}`,
          },
          timeout: 3600000,
        },
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Grok API returned an empty response');
      }

      return content;
    } catch (error) {
      console.error('Error calling Grok API:', error);
      throw new Error(`Failed to generate AI response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
