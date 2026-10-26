import axios from 'axios';
import * as dotenv from 'dotenv';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import { getFamiliarityResults, getQualityResults } from './common';
import { IAiProvider } from './IAiProvider';
import { AI_REQUEST_TIMEOUT_MS } from '../lib/utils';

// Load environment variables
dotenv.config();

export type XiaomiSourceAi = 'mimo-v2.6-pro';

/** Maps app-facing aliases to Xiaomi MiMo API model IDs. */
const XIAOMI_API_MODEL_ID: Record<XiaomiSourceAi, string> = {
  'mimo-v2.6-pro': 'mimo-v2.6-pro',
};

/**
 * OpenAI-compatible endpoint for the Token Plan Singapore cluster (`tp-...` keys).
 * Token Plan keys are cluster-specific (cn / sgp / ams); pay-as-you-go keys (`sk-...`)
 * use https://api.xiaomimimo.com/v1 instead.
 */
const XIAOMI_API_BASE_URL = 'https://token-plan-sgp.xiaomimimo.com/v1';

const MAX_XIAOMI_ATTEMPTS = 5;

function xiaomiApiModelId(source: XiaomiSourceAi): string {
  return XIAOMI_API_MODEL_ID[source];
}

function getXiaomiApiKey(): string {
  const apiKey = process.env.XIAOMI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('XIAOMI_API_KEY environment variable is not set');
  }
  return apiKey;
}

function isRetryableXiaomiError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const status = error.response?.status;
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }

  return status === undefined && error.code === 'ECONNRESET';
}

function xiaomiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const apiMessage = (error.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    return apiMessage ? `${error.message} - ${apiMessage}` : error.message;
  }

  return error instanceof Error ? error.message : 'Unknown error';
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class XiaomiAiProvider implements IAiProvider {
  sourceAI: XiaomiSourceAi;

  constructor(sourceAi: XiaomiSourceAi = 'mimo-v2.6-pro') {
    this.sourceAI = sourceAi;
  }

  async getFamiliarityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<FamiliarityResult[]> {
    return await getFamiliarityResults(this, entries, lang, mockData);
  }

  async getQualityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<QualityResult[]> {
    return await getQualityResults(this, entries, lang, mockData);
  }

  async generateResultsAsync(prompt: string, timeoutMs: number = AI_REQUEST_TIMEOUT_MS): Promise<string> {
    const apiKey = getXiaomiApiKey();
    const model = xiaomiApiModelId(this.sourceAI);
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_XIAOMI_ATTEMPTS; attempt++) {
      try {
        const response = await axios.post(
          `${XIAOMI_API_BASE_URL}/chat/completions`,
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'api-key': apiKey,
            },
            timeout: timeoutMs,
          },
        );

        const text = response.data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) {
          throw new Error('Xiaomi MiMo API returned an empty response');
        }

        return text;
      } catch (error) {
        lastError = error;

        if (attempt < MAX_XIAOMI_ATTEMPTS && isRetryableXiaomiError(error)) {
          const delayMs = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
          console.warn(
            `Xiaomi MiMo API unavailable for ${model} (attempt ${attempt}/${MAX_XIAOMI_ATTEMPTS}), retrying in ${delayMs}ms...`,
          );
          await sleep(delayMs);
          continue;
        }

        // Log the message only: the raw axios error includes request headers, which carry the API key.
        console.error('Error calling Xiaomi MiMo API:', xiaomiErrorMessage(error));
        throw new Error(`Failed to generate AI response: ${xiaomiErrorMessage(error)}`);
      }
    }

    throw new Error(`Failed to generate AI response: ${xiaomiErrorMessage(lastError)}`);
  }
}
