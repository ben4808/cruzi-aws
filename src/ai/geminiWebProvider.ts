import * as dotenv from 'dotenv';
import puppeteer, { Browser, Page } from 'puppeteer';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import { getFamiliarityResults, getQualityResults } from './common';
import { IAiProvider } from './IAiProvider';

dotenv.config();

export type GeminiWebSourceAi = 'gemini-web' | 'gemini-web-extended-flash';

type GeminiWebThinkingLevel = 'standard' | 'extended';

const GEMINI_APP_URL = 'https://gemini.google.com/app';

const EDITOR_SELECTORS = [
  'div.ql-editor',
  '[aria-label="Enter a prompt here"]',
  'rich-textarea div[contenteditable="true"]',
  '.text-input-field_textarea-inner',
];

const RESPONSE_SELECTORS = [
  'message-content .markdown',
  'message-content',
  'model-response .markdown',
  'model-response',
  '.response-content',
  '.model-response-text',
  '[data-message-author-role="model"]',
  '[class*="model-response"]',
];

const SEND_BUTTON_SELECTOR = 'button[aria-label="Send message"]';

const RESPONSE_STABLE_POLLS = 4;
const RESPONSE_POLL_INTERVAL_MS = 800;
const GEMINI_GENERATION_TIMEOUT_MS = 180_000;
const PUPPETEER_OPERATION_TIMEOUT_MS = GEMINI_GENERATION_TIMEOUT_MS;

const GENERATING_INDICATOR_SELECTORS = [
  'button[aria-label="Stop response"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop"]',
  '[data-test-id="stop-button"]',
  'mat-icon[data-mat-icon-name="stop"]',
];

const WAIT_LOG_INTERVAL_MS = 30_000;
const GEMINI_EDITOR_WAIT_MS = 60_000;
const GEMINI_ATTEMPTS_PER_ROUND = 5;
const GEMINI_ROUND_COOLDOWN_MS = 10 * 60 * 1000;

function thinkingLevelForSource(source: GeminiWebSourceAi): GeminiWebThinkingLevel {
  return source === 'gemini-web-extended-flash' ? 'extended' : 'standard';
}

type GeminiWebTimeouts = {
  generationTimeoutMs: number;
};

function timeoutsForThinkingLevel(_thinkingLevel: GeminiWebThinkingLevel): GeminiWebTimeouts {
  return {
    generationTimeoutMs: GEMINI_GENERATION_TIMEOUT_MS,
  };
}

function isGeminiWebHeadless(): boolean {
  return process.env.GEMINI_WEB_HEADLESS !== 'false';
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findFirstSelector(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (handle) {
      await handle.dispose();
      return selector;
    }
  }
  return null;
}

async function waitForAnySelector(
  page: Page,
  selectors: string[],
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const selector = await findFirstSelector(page, selectors);
    if (selector) {
      return selector;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for selectors: ${selectors.join(', ')}`);
}

async function waitForGeminiApp(page: Page): Promise<void> {
  try {
    await waitForAnySelector(page, EDITOR_SELECTORS, GEMINI_EDITOR_WAIT_MS);
  } catch {
    throw new Error(
      'Gemini app prompt editor did not appear. Guest access may be blocked or the page UI changed.',
    );
  }
}

function stripGeminiWebUiChrome(text: string): string {
  return text.replace(/^Gemini said\s*\n?/i, '').trim();
}

async function getLatestResponseText(page: Page): Promise<string> {
  const rawText = await page.evaluate((selectors) => {
    const blockTags = new Set([
      'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'PRE', 'BLOCKQUOTE', 'TR', 'SECTION', 'ARTICLE',
    ]);

    function extractPlainTextWithLineBreaks(element: Element): string {
      function walk(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent ?? '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }

        const el = node as Element;
        if (el.tagName === 'BR') {
          return '\n';
        }

        let text = '';
        for (const child of Array.from(el.childNodes)) {
          text += walk(child);
        }
        if (blockTags.has(el.tagName) && text.length > 0) {
          text += '\n';
        }
        return text;
      }

      return walk(element).replace(/\n{3,}/g, '\n\n').trim();
    }

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length === 0) {
        continue;
      }

      const element = nodes[nodes.length - 1];
      const text =
        element instanceof HTMLElement && element.innerText.trim().length > 0
          ? element.innerText.trim()
          : extractPlainTextWithLineBreaks(element);
      if (text.length > 0) {
        return text;
      }
    }

    return '';
  }, RESPONSE_SELECTORS);

  return stripGeminiWebUiChrome(rawText);
}

async function isResponseGenerating(page: Page): Promise<boolean> {
  return page.evaluate(
    ({ stopSelectors, sendSelector }) => {
      for (const selector of stopSelectors) {
        const element = document.querySelector(selector);
        if (element?.isConnected) {
          return true;
        }
      }

      const send = document.querySelector(sendSelector);
      return send instanceof HTMLButtonElement && send.disabled;
    },
    {
      stopSelectors: GENERATING_INDICATOR_SELECTORS,
      sendSelector: SEND_BUTTON_SELECTOR,
    },
  );
}

async function startNewChat(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    const byAria = document.querySelector('[aria-label*="New chat"], [aria-label*="new chat"]');
    if (byAria instanceof HTMLElement) {
      byAria.click();
      return true;
    }

    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    const newChat = candidates.find((element) => /new chat/i.test(element.textContent ?? ''));
    if (newChat instanceof HTMLElement) {
      newChat.click();
      return true;
    }

    return false;
  });

  if (!clicked) {
    await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } else {
    await sleep(1000);
  }

  await waitForAnySelector(page, EDITOR_SELECTORS, 30_000);
}

async function setEditorTextViaKeyboard(page: Page, editorSelector: string, prompt: string): Promise<void> {
  await page.click(editorSelector);
  await sleep(200);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');

  const lines = prompt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      await page.keyboard.type(lines[i], { delay: 0 });
    }
    if (i < lines.length - 1) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
    }
  }

  await page.evaluate((selector) => {
    const editor = document.querySelector(selector);
    if (editor instanceof HTMLElement) {
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }, editorSelector);
}

async function setEditorText(page: Page, editorSelector: string, prompt: string): Promise<void> {
  await page.click(editorSelector);
  await sleep(200);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');

  const client = await page.createCDPSession();
  try {
    await client.send('Input.insertText', { text: prompt });
  } finally {
    await client.detach();
  }

  await page.evaluate((selector) => {
    const editor = document.querySelector(selector);
    if (editor instanceof HTMLElement) {
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }, editorSelector);

  const insertedLength = await page.evaluate((selector) => {
    const editor = document.querySelector(selector);
    return editor?.textContent?.length ?? 0;
  }, editorSelector);

  if (insertedLength < prompt.trim().length * 0.9) {
    await setEditorTextViaKeyboard(page, editorSelector, prompt);
  }

  const inserted = await page.evaluate((selector) => {
    const editor = document.querySelector(selector);
    return editor?.textContent?.trim() ?? '';
  }, editorSelector);

  if (!inserted) {
    throw new Error('Failed to insert prompt into Gemini editor');
  }
}

async function waitForSendButtonEnabled(page: Page): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const isEnabled = await page.evaluate((selector) => {
      const button = document.querySelector(selector);
      return button instanceof HTMLButtonElement && !button.disabled;
    }, SEND_BUTTON_SELECTOR);

    if (isEnabled) {
      return;
    }
    await sleep(200);
  }
}

async function submitPrompt(page: Page): Promise<void> {
  await waitForSendButtonEnabled(page);

  const sendButton = await page.$(SEND_BUTTON_SELECTOR);
  if (sendButton) {
    await sendButton.click();
    await sendButton.dispose();
    return;
  }

  await page.keyboard.press('Enter');
}

async function waitForGeminiResponse(page: Page, timeoutMs: number): Promise<string> {
  let lastText = '';
  let stablePolls = 0;
  let sawActivity = false;
  const start = Date.now();
  let lastLogAt = start;

  while (stablePolls < RESPONSE_STABLE_POLLS) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error(
        `Timed out after ${Math.round(elapsed / 1000)}s waiting for Gemini response (activity=${sawActivity}, textLength=${lastText.length})`,
      );
    }

    try {
      if (Date.now() - lastLogAt >= WAIT_LOG_INTERVAL_MS) {
        console.log(
          `Still waiting for Gemini response (${Math.round(elapsed / 1000)}s, activity=${sawActivity}, generating=${await isResponseGenerating(page)})...`,
        );
        lastLogAt = Date.now();
      }

      const generating = await isResponseGenerating(page);
      const currentText = await getLatestResponseText(page);

      if (generating || currentText.length > 0) {
        sawActivity = true;
      }

      if (!sawActivity) {
        await sleep(500);
        continue;
      }

      if (generating) {
        stablePolls = 0;
        lastText = '';
        await sleep(RESPONSE_POLL_INTERVAL_MS);
        continue;
      }

      if (currentText.length === 0) {
        stablePolls = 0;
        lastText = '';
        await sleep(RESPONSE_POLL_INTERVAL_MS);
        continue;
      }

      if (currentText === lastText) {
        stablePolls++;
      } else {
        stablePolls = 0;
        lastText = currentText;
      }

      await sleep(RESPONSE_POLL_INTERVAL_MS);
    } catch (error) {
      if (!isDetachedFrameError(error)) {
        throw error;
      }

      console.warn(
        'Gemini page frame detached while waiting for response; waiting for frame to reattach...',
      );
      await waitForPageFrame(page, 15_000);
      await waitForAnySelector(page, EDITOR_SELECTORS, 30_000).catch(() => undefined);
      stablePolls = 0;
      lastText = '';
      sawActivity = false;
    }
  }

  if (!lastText) {
    throw new Error('Gemini web returned an empty response');
  }

  return lastText;
}

function isResponseWaitTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out/i.test(message);
}

function isDetachedFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /detached frame/i.test(message);
}

function isRecoverableGeminiSessionError(error: unknown): boolean {
  return isResponseWaitTimeoutError(error) || isDetachedFrameError(error);
}

async function waitForPageFrame(page: Page, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await page.evaluate(() => true);
      return;
    } catch (error) {
      if (!isDetachedFrameError(error)) {
        throw error;
      }
      await sleep(500);
    }
  }
  throw new Error('Timed out waiting for Gemini page frame to reattach');
}

class GeminiWebSession {
  private browsers: Partial<Record<GeminiWebThinkingLevel, Browser>> = {};
  private pages: Partial<Record<GeminiWebThinkingLevel, Page>> = {};
  private pageSetup: Partial<Record<GeminiWebThinkingLevel, Promise<void>>> = {};
  private operationQueues: Partial<Record<GeminiWebThinkingLevel, Promise<unknown>>> = {};
  private lastResponses: Partial<Record<GeminiWebThinkingLevel, string>> = {};

  constructor(private readonly workerId?: number) {}

  private workerLabel(): string {
    return this.workerId == null ? 'default' : `worker-${this.workerId}`;
  }

  private async launchBrowser(thinkingLevel: GeminiWebThinkingLevel): Promise<Browser> {
    const existing = this.browsers[thinkingLevel];
    if (existing) {
      return existing;
    }

    const browser = await puppeteer.launch({
      headless: isGeminiWebHeadless(),
      protocolTimeout: PUPPETEER_OPERATION_TIMEOUT_MS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    this.browsers[thinkingLevel] = browser;
    return browser;
  }

  private async ensurePage(thinkingLevel: GeminiWebThinkingLevel): Promise<Page> {
    if (!this.pageSetup[thinkingLevel]) {
      this.pageSetup[thinkingLevel] = this.setupPage(thinkingLevel);
    }

    await this.pageSetup[thinkingLevel];

    const page = this.pages[thinkingLevel];
    if (!page) {
      throw new Error(`Gemini web session failed to initialize ${thinkingLevel} page`);
    }

    return page;
  }

  private async setupPage(thinkingLevel: GeminiWebThinkingLevel): Promise<void> {
    const browser = await this.launchBrowser(thinkingLevel);
    const page = await browser.newPage();
    await page.setDefaultTimeout(PUPPETEER_OPERATION_TIMEOUT_MS);
    await page.setDefaultNavigationTimeout(60_000);
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForGeminiApp(page);
    this.pages[thinkingLevel] = page;
    console.log(
      `Gemini web guest session ready for ${thinkingLevel} profile (${this.workerLabel()}, default Flash)`,
    );
  }

  private async restartBrowser(thinkingLevel: GeminiWebThinkingLevel): Promise<void> {
    console.log(
      `Restarting Gemini web browser for ${thinkingLevel} profile (${this.workerLabel()})...`,
    );

    await this.pages[thinkingLevel]?.close().catch(() => undefined);
    await this.browsers[thinkingLevel]?.close().catch(() => undefined);

    delete this.browsers[thinkingLevel];
    delete this.pages[thinkingLevel];
    delete this.pageSetup[thinkingLevel];
  }

  private async generateOnce(
    prompt: string,
    thinkingLevel: GeminiWebThinkingLevel,
    timeouts: GeminiWebTimeouts,
    attempt: number,
  ): Promise<string> {
    const page = await this.ensurePage(thinkingLevel);

    await startNewChat(page);

    const editorSelector = await waitForAnySelector(page, EDITOR_SELECTORS, 30_000);
    await setEditorText(page, editorSelector, prompt);
    await sleep(300);
    await submitPrompt(page);

    console.log(
      `Waiting up to ${timeouts.generationTimeoutMs / 1000}s for Gemini Flash response (attempt ${attempt})...`,
    );
    return waitForGeminiResponse(page, timeouts.generationTimeoutMs);
  }

  async generate(prompt: string, thinkingLevel: GeminiWebThinkingLevel): Promise<string> {
    const queue = this.operationQueues[thinkingLevel] ?? Promise.resolve();
    const run = async (): Promise<string> => {
      const timeouts = timeoutsForThinkingLevel(thinkingLevel);
      let round = 1;

      while (true) {
        for (let attempt = 1; attempt <= GEMINI_ATTEMPTS_PER_ROUND; attempt++) {
          const absoluteAttempt = (round - 1) * GEMINI_ATTEMPTS_PER_ROUND + attempt;
          try {
            const response = await this.generateOnce(
              prompt,
              thinkingLevel,
              timeouts,
              absoluteAttempt,
            );

            if (response === this.lastResponses[thinkingLevel]) {
              const isLastInRound = attempt >= GEMINI_ATTEMPTS_PER_ROUND;
              console.warn(
                `Gemini ${thinkingLevel} returned the exact same reply as the previous request (attempt ${attempt}/${GEMINI_ATTEMPTS_PER_ROUND} in round ${round}); ${
                  isLastInRound
                    ? `waiting ${GEMINI_ROUND_COOLDOWN_MS / 60_000} minutes before next round...`
                    : 're-initializing Gemini web session and retrying...'
                }`,
              );
              continue;
            }

            this.lastResponses[thinkingLevel] = response;
            return response;
          } catch (error) {
            if (!isRecoverableGeminiSessionError(error)) {
              throw error;
            }

            const isLastInRound = attempt >= GEMINI_ATTEMPTS_PER_ROUND;
            const reason = isDetachedFrameError(error)
              ? 'page frame detached'
              : `response timed out after ${timeouts.generationTimeoutMs / 1000}s`;
            console.warn(
              `Gemini ${thinkingLevel} ${reason} (attempt ${attempt}/${GEMINI_ATTEMPTS_PER_ROUND} in round ${round}); ${
                isLastInRound
                  ? `waiting ${GEMINI_ROUND_COOLDOWN_MS / 60_000} minutes before next round...`
                  : 'restarting browser and retrying...'
              }`,
            );
          } finally {
            await this.restartBrowser(thinkingLevel);
          }
        }

        console.log(
          `Gemini ${thinkingLevel} round ${round} exhausted (${GEMINI_ATTEMPTS_PER_ROUND} attempts). Cooling down for ${GEMINI_ROUND_COOLDOWN_MS / 60_000} minutes...`,
        );
        await sleep(GEMINI_ROUND_COOLDOWN_MS);
        round++;
      }
    };

    const result = queue.then(run);
    this.operationQueues[thinkingLevel] = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    for (const page of Object.values(this.pages)) {
      await page?.close().catch(() => undefined);
    }

    for (const browser of Object.values(this.browsers)) {
      await browser?.close().catch(() => undefined);
    }

    this.browsers = {};
    this.pages = {};
    this.pageSetup = {};
    this.operationQueues = {};
    this.lastResponses = {};
  }
}

const geminiWebSessions = new Map<string, GeminiWebSession>();

function sessionKeyForWorker(workerId?: number): string {
  return workerId == null ? 'default' : `worker-${workerId}`;
}

function getGeminiWebSession(workerId?: number): GeminiWebSession {
  const key = sessionKeyForWorker(workerId);
  let session = geminiWebSessions.get(key);
  if (!session) {
    session = new GeminiWebSession(workerId);
    geminiWebSessions.set(key, session);
  }
  return session;
}

export class GeminiWebAiProvider implements IAiProvider {
  sourceAI: GeminiWebSourceAi;
  private readonly workerId?: number;

  constructor(sourceAi: GeminiWebSourceAi = 'gemini-web', workerId?: number) {
    this.sourceAI = sourceAi;
    this.workerId = workerId;
  }

  async getFamiliarityResultsAsync(
    entries: Entry[],
    lang: string,
    mockData: boolean,
  ): Promise<FamiliarityResult[]> {
    return getFamiliarityResults(this, entries, lang, mockData);
  }

  async getQualityResultsAsync(
    entries: Entry[],
    lang: string,
    mockData: boolean,
  ): Promise<QualityResult[]> {
    return getQualityResults(this, entries, lang, mockData);
  }

  async generateResultsAsync(prompt: string): Promise<string> {
    try {
      return await getGeminiWebSession(this.workerId).generate(
        prompt,
        thinkingLevelForSource(this.sourceAI),
      );
    } catch (error) {
      console.error('Error calling Gemini web:', error);
      throw new Error(
        `Failed to generate AI response: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}

export async function closeGeminiWebSession(): Promise<void> {
  const sessions = [...geminiWebSessions.values()];
  geminiWebSessions.clear();
  await Promise.all(sessions.map((session) => session.close()));
}
