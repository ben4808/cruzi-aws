import { Agent, CursorAgentError, type ModelSelection } from '@cursor/sdk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import { getFamiliarityResults, getQualityResults } from './common';
import { IAiProvider } from './IAiProvider';
import { AI_REQUEST_TIMEOUT_MS, AiRequestTimeoutError, withTimeout } from '../lib/utils';

dotenv.config();

/** Supported Cursor plan models (non-fast variants only). */
export type CursorSourceAi = 'composer-2.5' | 'grok-4.5' | 'grok-4.6' | 'gemini-3.7-flash';

/**
 * Explicit SDK selections so we never fall through to Fast defaults.
 * - Composer 2.5: standard (fast=false)
 * - Grok 4.5 / 4.6: Medium effort, non-fast
 * - Gemini 3.7 Flash (high): High effort
 */
const CURSOR_MODEL_SELECTION: Record<CursorSourceAi, ModelSelection> = {
  'composer-2.5': {
    id: 'composer-2.5',
    params: [{ id: 'fast', value: 'false' }],
  },
  'grok-4.5': {
    id: 'grok-4.5',
    params: [
      { id: 'effort', value: 'medium' },
      { id: 'fast', value: 'false' },
    ],
  },
  'grok-4.6': {
    id: 'grok-4.6',
    params: [
      { id: 'effort', value: 'medium' },
      { id: 'fast', value: 'false' },
    ],
  },
  'gemini-3.7-flash': {
    id: 'gemini-3.7-flash',
    params: [{ id: 'effort', value: 'high' }],
  },
};

const MAX_CURSOR_ATTEMPTS = 5;
const CURSOR_UNAVAILABLE_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];

function cursorModelSelection(source: CursorSourceAi): ModelSelection {
  return CURSOR_MODEL_SELECTION[source];
}

function isRetryableCursorError(error: unknown): boolean {
  if (error instanceof AiRequestTimeoutError) {
    return false;
  }

  if (error instanceof CursorAgentError && error.isRetryable) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|rate limit|high demand|timeout|empty response/i.test(
    message,
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCursorApiKey(): string {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('CURSOR_API_KEY environment variable is not set');
  }
  return apiKey;
}

let sharedEmptyWorkspaceCwd: string | undefined;

/**
 * Empty workspace so the agent answers as a text model instead of exploring this repo.
 * Override with CURSOR_AI_CWD if you want a specific working directory.
 */
function getCursorWorkspaceCwd(): string {
  if (process.env.CURSOR_AI_CWD) {
    return process.env.CURSOR_AI_CWD;
  }

  if (!sharedEmptyWorkspaceCwd) {
    sharedEmptyWorkspaceCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cruzi-cursor-ai-'));
  }

  return sharedEmptyWorkspaceCwd;
}

function buildTextOnlyPrompt(prompt: string): string {
  return [
    'You are a text-generation API. Reply with only the final answer text.',
    'Do not use tools, edit files, run shell commands, or ask follow-up questions.',
    '',
    prompt,
  ].join('\n');
}

export class CursorAiProvider implements IAiProvider {
  sourceAI: CursorSourceAi;

  constructor(sourceAi: CursorSourceAi = 'grok-4.6') {
    this.sourceAI = sourceAi;
  }

  async getFamiliarityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<FamiliarityResult[]> {
    return await getFamiliarityResults(this, entries, lang, mockData);
  }

  async getQualityResultsAsync(entries: Entry[], lang: string, mockData: boolean): Promise<QualityResult[]> {
    return await getQualityResults(this, entries, lang, mockData);
  }

  async generateResultsAsync(prompt: string, timeoutMs: number = AI_REQUEST_TIMEOUT_MS): Promise<string> {
    const apiKey = getCursorApiKey();
    const model = cursorModelSelection(this.sourceAI);
    const cwd = getCursorWorkspaceCwd();
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_CURSOR_ATTEMPTS; attempt++) {
      try {
        const result = await withTimeout(
          Agent.prompt(buildTextOnlyPrompt(prompt), {
            apiKey,
            model,
            local: {
              cwd,
              // Inline config only — do not load project/user Cursor settings.
              settingSources: [],
            },
          }),
          timeoutMs,
        );

        if (result.status === 'error') {
          throw new Error(result.error?.message ?? `Cursor run failed (id=${result.id})`);
        }

        if (result.status === 'cancelled') {
          throw new Error(`Cursor run was cancelled (id=${result.id})`);
        }

        const text = result.result?.trim();
        if (!text) {
          throw new Error('Cursor API returned an empty response');
        }

        return text;
      } catch (error) {
        lastError = error;

        if (error instanceof AiRequestTimeoutError) {
          throw error;
        }

        if (attempt < MAX_CURSOR_ATTEMPTS && isRetryableCursorError(error)) {
          const delayMs = CURSOR_UNAVAILABLE_RETRY_DELAYS_MS[attempt - 1];
          console.warn(
            `Cursor API unavailable for ${model.id} (attempt ${attempt}/${MAX_CURSOR_ATTEMPTS}), retrying in ${delayMs / 1000}s...`,
          );
          await sleep(delayMs);
          continue;
        }

        console.error('Error calling Cursor API:', error);
        throw new Error(`Failed to generate AI response: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    throw new Error(`Failed to generate AI response: ${lastError instanceof Error ? lastError.message : 'Unknown error'}`);
  }
}
