import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import { getFamiliarityResults, getQualityResults } from './common';
import { IAiProvider } from './IAiProvider';

dotenv.config();

export type GeminiWebSourceAi = 'gemini-web' | 'gemini-web-extended-flash';

type GeminiWebThinkingLevel = 'standard' | 'extended';

const GEMINI_APP_URL = 'https://gemini.google.com/app';
const LEGACY_USER_DATA_DIR = path.join(process.cwd(), '.gemini-user-data');

function userDataDirForThinkingLevel(thinkingLevel: GeminiWebThinkingLevel): string {
  const dir = path.join(process.cwd(), `.gemini-user-data-${thinkingLevel}`);
  if (!fs.existsSync(dir) && fs.existsSync(LEGACY_USER_DATA_DIR)) {
    fs.cpSync(LEGACY_USER_DATA_DIR, dir, { recursive: true });
  }
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

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

const SIGN_IN_SELECTORS = [
  'a[href*="accounts.google.com"]',
  'button[data-test-id="sign-in-button"]',
  'a[aria-label="Sign in"]',
];

const SEND_BUTTON_SELECTOR = 'button[aria-label="Send message"]';

const MODEL_SELECTOR_SELECTORS = [
  'button.input-area-switch-label',
  '[data-test-id="model-selector"]',
  'button[aria-haspopup="menu"].mat-mdc-menu-trigger',
];

const RESPONSE_STABLE_POLLS = 4;
const RESPONSE_POLL_INTERVAL_MS = 800;
const STANDARD_RESPONSE_APPEAR_TIMEOUT_MS = 120_000;
const EXTENDED_RESPONSE_APPEAR_TIMEOUT_MS = 600_000;
const STANDARD_GENERATION_TIMEOUT_MS = 600_000;
const EXTENDED_GENERATION_TIMEOUT_MS = 600_000;
const PUPPETEER_OPERATION_TIMEOUT_MS = EXTENDED_GENERATION_TIMEOUT_MS;

const GENERATING_INDICATOR_SELECTORS = [
  'button[aria-label="Stop response"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop"]',
  '[data-test-id="stop-button"]',
  'mat-icon[data-mat-icon-name="stop"]',
];

const WAIT_LOG_INTERVAL_MS = 30_000;
const GEMINI_EDITOR_WAIT_MS = 60_000;
const GEMINI_MANUAL_LOGIN_WAIT_MS = 300_000;

type GeminiWebTimeouts = {
  responseAppearTimeoutMs: number;
  generationTimeoutMs: number;
};

function thinkingLevelForSource(source: GeminiWebSourceAi): GeminiWebThinkingLevel {
  return source === 'gemini-web-extended-flash' ? 'extended' : 'standard';
}

function timeoutsForThinkingLevel(thinkingLevel: GeminiWebThinkingLevel): GeminiWebTimeouts {
  if (thinkingLevel === 'extended') {
    return {
      responseAppearTimeoutMs: EXTENDED_RESPONSE_APPEAR_TIMEOUT_MS,
      generationTimeoutMs: EXTENDED_GENERATION_TIMEOUT_MS,
    };
  }

  return {
    responseAppearTimeoutMs: STANDARD_RESPONSE_APPEAR_TIMEOUT_MS,
    generationTimeoutMs: STANDARD_GENERATION_TIMEOUT_MS,
  };
}

function getGoogleCredentials(): { email: string; password: string } | null {
  const email = process.env.GOOGLE_EMAIL;
  const password = process.env.GOOGLE_PASSWORD;
  if (!email || !password) {
    return null;
  }
  return { email, password };
}

function isGeminiWebHeadless(): boolean {
  return process.env.GEMINI_WEB_HEADLESS !== 'false';
}

async function waitForGeminiEditor(page: Page, timeoutMs: number): Promise<boolean> {
  try {
    await waitForAnySelector(page, EDITOR_SELECTORS, timeoutMs);
    return true;
  } catch {
    return false;
  }
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

async function isGoogleLoginPage(page: Page): Promise<boolean> {
  const url = page.url();
  return url.includes('accounts.google.com');
}

async function completeGoogleLogin(page: Page, email: string, password: string): Promise<void> {
  await page.waitForSelector('#identifierId, input[type="email"]', { timeout: 30_000 });
  const emailInput = (await page.$('#identifierId')) ?? (await page.$('input[type="email"]'));
  if (!emailInput) {
    throw new Error('Google login email field not found');
  }

  await emailInput.click({ count: 3 });
  await emailInput.type(email, { delay: 25 });
  await page.keyboard.press('Enter');

  await page.waitForSelector('input[type="password"], input[name="Passwd"]', { timeout: 30_000 });
  const passwordInput =
    (await page.$('input[name="Passwd"]')) ?? (await page.$('input[type="password"]'));
  if (!passwordInput) {
    throw new Error('Google login password field not found');
  }

  await passwordInput.click({ count: 3 });
  await passwordInput.type(password, { delay: 25 });
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    () => !window.location.hostname.includes('accounts.google.com'),
    { timeout: 120_000 },
  );
}

async function clickSignInIfPresent(page: Page): Promise<boolean> {
  for (const selector of SIGN_IN_SELECTORS) {
    const button = await page.$(selector);
    if (!button) {
      continue;
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => undefined),
      button.click(),
    ]);
    return true;
  }

  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('a, button'));
    const signIn = candidates.find((element) => /sign in/i.test(element.textContent ?? ''));
    if (!signIn || !(signIn instanceof HTMLElement)) {
      return false;
    }
    signIn.click();
    return true;
  });

  if (clicked) {
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => undefined);
  }

  return clicked;
}

async function ensureGeminiLogin(page: Page): Promise<void> {
  if (await waitForGeminiEditor(page, GEMINI_EDITOR_WAIT_MS)) {
    return;
  }

  const credentials = getGoogleCredentials();

  if (!credentials) {
    if (!isGeminiWebHeadless()) {
      console.log(
        `Log in to Gemini in the browser window. Waiting up to ${GEMINI_MANUAL_LOGIN_WAIT_MS / 1000}s for the prompt editor...`,
      );
      if (await waitForGeminiEditor(page, GEMINI_MANUAL_LOGIN_WAIT_MS)) {
        return;
      }
    }

    throw new Error(
      'Not logged in to Gemini. Set GOOGLE_EMAIL and GOOGLE_PASSWORD in .env, or run once with GEMINI_WEB_HEADLESS=false to log in manually (sessions are saved in .gemini-user-data-extended and .gemini-user-data-standard).',
    );
  }

  const { email, password } = credentials;

  if (await isGoogleLoginPage(page)) {
    await completeGoogleLogin(page, email, password);
  } else {
    await clickSignInIfPresent(page);
    if (await isGoogleLoginPage(page)) {
      await completeGoogleLogin(page, email, password);
    }
  }

  await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  if (!(await waitForGeminiEditor(page, GEMINI_EDITOR_WAIT_MS))) {
    if (await isGoogleLoginPage(page)) {
      await completeGoogleLogin(page, email, password);
      await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
  }

  if (!(await waitForGeminiEditor(page, GEMINI_EDITOR_WAIT_MS))) {
    throw new Error(
      'Failed to log in to Gemini. Check GOOGLE_EMAIL/GOOGLE_PASSWORD or complete 2FA in a persistent session.',
    );
  }
}

async function getLatestResponseText(page: Page): Promise<string> {
  return page.evaluate((selectors) => {
    let bestText = '';

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length === 0) {
        continue;
      }

      const text = nodes[nodes.length - 1].textContent?.trim() ?? '';
      if (text.length > bestText.length) {
        bestText = text;
      }
    }

    return bestText;
  }, RESPONSE_SELECTORS);
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
  }

  if (!lastText) {
    throw new Error('Gemini web returned an empty response');
  }

  return lastText;
}

async function getModelSelectorText(page: Page): Promise<string> {
  return page.evaluate((selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const ariaLabel = element.getAttribute('aria-label') ?? '';
        const text = element.textContent?.trim() ?? '';
        return `${text} ${ariaLabel}`.trim();
      }
    }
    return '';
  }, MODEL_SELECTOR_SELECTORS);
}

function modelLabelForThinkingLevel(thinkingLevel: GeminiWebThinkingLevel): string {
  return thinkingLevel === 'extended' ? 'Extended Flash' : 'Standard Flash';
}

async function logGeminiModelExpectation(
  page: Page,
  thinkingLevel: GeminiWebThinkingLevel,
): Promise<void> {
  const selectorText = await getModelSelectorText(page);
  const expected = modelLabelForThinkingLevel(thinkingLevel);
  const profileDir = `.gemini-user-data-${thinkingLevel}`;

  if (selectorText) {
    console.log(
      `Gemini ${thinkingLevel} profile model: "${selectorText}". Configure ${expected} once in ${profileDir} if needed.`,
    );
    return;
  }

  console.log(
    `Gemini ${thinkingLevel} profile ready. Configure ${expected} once in the browser (saved in ${profileDir}).`,
  );
}

class GeminiWebSession {
  private browsers: Partial<Record<GeminiWebThinkingLevel, Browser>> = {};
  private pages: Partial<Record<GeminiWebThinkingLevel, Page>> = {};
  private pageSetup: Partial<Record<GeminiWebThinkingLevel, Promise<void>>> = {};
  private operationQueues: Partial<Record<GeminiWebThinkingLevel, Promise<unknown>>> = {};

  private async launchBrowser(thinkingLevel: GeminiWebThinkingLevel): Promise<Browser> {
    const existing = this.browsers[thinkingLevel];
    if (existing) {
      return existing;
    }

    const browser = await puppeteer.launch({
      headless: isGeminiWebHeadless(),
      userDataDir: userDataDirForThinkingLevel(thinkingLevel),
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
    await ensureGeminiLogin(page);
    await logGeminiModelExpectation(page, thinkingLevel);
    this.pages[thinkingLevel] = page;
    console.log(`Gemini web session ready for ${thinkingLevel} profile`);
  }

  async generate(prompt: string, thinkingLevel: GeminiWebThinkingLevel): Promise<string> {
    const queue = this.operationQueues[thinkingLevel] ?? Promise.resolve();
    const run = async (): Promise<string> => {
      const page = await this.ensurePage(thinkingLevel);
      const timeouts = timeoutsForThinkingLevel(thinkingLevel);

      await startNewChat(page);

      const editorSelector = await waitForAnySelector(page, EDITOR_SELECTORS, 30_000);

      await setEditorText(page, editorSelector, prompt);
      await sleep(300);
      await submitPrompt(page);

      console.log(
        `Waiting up to ${timeouts.generationTimeoutMs / 1000}s for Gemini ${thinkingLevel} Flash response...`,
      );
      return waitForGeminiResponse(page, timeouts.generationTimeoutMs);
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
  }
}

let geminiWebSession: GeminiWebSession | undefined;

function getGeminiWebSession(): GeminiWebSession {
  if (!geminiWebSession) {
    geminiWebSession = new GeminiWebSession();
  }
  return geminiWebSession;
}

export class GeminiWebAiProvider implements IAiProvider {
  sourceAI: GeminiWebSourceAi;

  constructor(sourceAi: GeminiWebSourceAi = 'gemini-web') {
    this.sourceAI = sourceAi;
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
      return await getGeminiWebSession().generate(prompt, thinkingLevelForSource(this.sourceAI));
    } catch (error) {
      console.error('Error calling Gemini web:', error);
      throw new Error(
        `Failed to generate AI response: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}

export async function closeGeminiWebSession(): Promise<void> {
  if (geminiWebSession) {
    await geminiWebSession.close();
    geminiWebSession = undefined;
  }
}
