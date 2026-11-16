import axios from 'axios';
import * as dotenv from 'dotenv';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import { getFamiliarityResults, getQualityResults } from './common';
import { IAiProvider } from './IAiProvider';
import { AI_REQUEST_TIMEOUT_MS } from '../lib/utils';

dotenv.config();

/** Muse Ember, Meta's efficient Muse model. */
export type MuseSourceAi = 'muse-ember';

export type MuseReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** App-facing alias -> Meta Model API model id. */
const MUSE_API_MODEL_ID: Record<MuseSourceAi, string> = {
  'muse-ember': 'muse-ember-1.0',
};

const MUSE_API_BASE_URL = 'https://api.meta.ai/v1';

const MAX_MUSE_ATTEMPTS = 5;

function museApiModelId(source: MuseSourceAi): string {
  return MUSE_API_MODEL_ID[source];
}

function getMuseApiKey(): string {
  const apiKey = process.env.MUSE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('MUSE_API_KEY environment variable is not set');
  }
  return apiKey;
}

function isRetryableMuseError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const status = error.response?.status;
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  return status === undefined && error.code === 'ECONNRESET';
}

function museErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const apiMessage = (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    return apiMessage ? `${error.message} - ${apiMessage}` : error.message;
  }

  return error instanceof Error ? error.message : 'Unknown error';
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && 'text' in part) return String((part as { text?: unknown }).text || '');
    return '';
  }).join('').trim();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MuseAiProvider implements IAiProvider {
  sourceAI: MuseSourceAi;

  constructor(
    sourceAi: MuseSourceAi = 'muse-ember',
    private reasoningEffort: MuseReasoningEffort = 'high',
  ) {
    this.sourceAI = sourceAi;
  }

  async getFamiliarityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<FamiliarityResult[]> {
    return await getFamiliarityResults(this, entries, lang, mockData);
  }

  async getQualityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<QualityResult[]> {
    return await getQualityResults(this, entries, lang, mockData);
  }

  async generateResultsAsync(prompt: string, timeoutMs: number = AI_REQUEST_TIMEOUT_MS): Promise<string> {
    const apiKey = getMuseApiKey();
    const model = museApiModelId(this.sourceAI);
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_MUSE_ATTEMPTS; attempt++) {
      try {
        const response = await axios.post(
          `${MUSE_API_BASE_URL}/chat/completions`,
          {
            model,
            reasoning_effort: this.reasoningEffort,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            timeout: timeoutMs,
          },
        );

        const text = messageText(response.data?.choices?.[0]?.message?.content);
        if (!text) {
          throw new Error('Muse API returned an empty response');
        }

        return text;
      } catch (error) {
        lastError = error;

        if (attempt < MAX_MUSE_ATTEMPTS && isRetryableMuseError(error)) {
          const delayMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
          console.warn(
            `Muse API unavailable for ${model} (attempt ${attempt}/${MAX_MUSE_ATTEMPTS}), retrying in ${delayMs}ms...`,
          );
          await sleep(delayMs);
          continue;
        }

        // Log the message only: the raw axios error includes request headers, which carry the API key.
        console.error('Error calling Muse API:', museErrorMessage(error));
        throw new Error(`Failed to generate AI response: ${museErrorMessage(error)}`);
      }
    }

    throw new Error(`Failed to generate AI response: ${museErrorMessage(lastError)}`);
  }
}
