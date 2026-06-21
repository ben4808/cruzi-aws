import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import { getFamiliarityResults, getQualityResults } from './common';
import { IAiProvider } from './IAiProvider';

dotenv.config();

export type GeminiWebSourceAi = 'gemini-web';

const GEMINI_APP_URL = 'https://gemini.google.com/app';
const USER_DATA_DIR = path.join(process.cwd(), '.gemini-user-data');

const EDITOR_SELECTORS = [
  'div.ql-editor',
  '[aria-label="Enter a prompt here"]',
  'rich-textarea div[contenteditable="true"]',
  '.text-input-field_textarea-inner',
];

const RESPONSE_SELECTORS = [
  'message-content .markdown',
  '.response-content',
  '.model-response-text',
];

const SIGN_IN_SELECTORS = [
  'a[href*="accounts.google.com"]',
  'button[data-test-id="sign-in-button"]',
  'a[aria-label="Sign in"]',
];

const SEND_BUTTON_SELECTOR = 'button[aria-label="Send message"]';

const RESPONSE_STABLE_POLLS = 4;
const RESPONSE_POLL_INTERVAL_MS = 800;
const RESPONSE_APPEAR_TIMEOUT_MS = 120_000;
const GENERATION_TIMEOUT_MS = 600_000;

function requireGoogleCredentials(): { email: string; password: string } {
  const email = process.env.GOOGLE_EMAIL;
  const password = process.env.GOOGLE_PASSWORD;
  if (!email || !password) {
    throw new Error('GOOGLE_EMAIL and GOOGLE_PASSWORD environment variables are required');
  }
  return { email, password };
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

async function isLoggedInToGemini(page: Page): Promise<boolean> {
  const editorSelector = await findFirstSelector(page, EDITOR_SELECTORS);
  return editorSelector !== null;
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
  if (await isLoggedInToGemini(page)) {
    return;
  }

  const { email, password } = requireGoogleCredentials();

  if (await isGoogleLoginPage(page)) {
    await completeGoogleLogin(page, email, password);
  } else {
    await clickSignInIfPresent(page);
    if (await isGoogleLoginPage(page)) {
      await completeGoogleLogin(page, email, password);
    }
  }

  await page.goto(GEMINI_APP_URL, { waitUntil: 'networkidle2', timeout: 60_000 });

  if (!(await isLoggedInToGemini(page))) {
    if (await isGoogleLoginPage(page)) {
      await completeGoogleLogin(page, email, password);
      await page.goto(GEMINI_APP_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    }
  }

  if (!(await isLoggedInToGemini(page))) {
    throw new Error(
      'Failed to log in to Gemini. Check GOOGLE_EMAIL/GOOGLE_PASSWORD or complete 2FA in a persistent session.',
    );
  }
}

async function countResponses(page: Page): Promise<number> {
  return page.evaluate((selectors) => {
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length > 0) {
        return nodes.length;
      }
    }
    return 0;
  }, RESPONSE_SELECTORS);
}

async function getLatestResponseText(page: Page): Promise<string> {
  return page.evaluate((selectors) => {
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      if (nodes.length > 0) {
        return nodes[nodes.length - 1].textContent?.trim() ?? '';
      }
    }
    return '';
  }, RESPONSE_SELECTORS);
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
  if (!sendButton) {
    throw new Error('Gemini send button not found');
  }

  await sendButton.click();
  await sendButton.dispose();
}

async function waitForNewResponse(page: Page, previousCount: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < RESPONSE_APPEAR_TIMEOUT_MS) {
    const count = await countResponses(page);
    if (count > previousCount) {
      return;
    }
    await sleep(300);
  }

  throw new Error('Timed out waiting for Gemini response to appear');
}

async function waitForResponseToFinish(page: Page): Promise<string> {
  let lastText = '';
  let stablePolls = 0;
  const start = Date.now();

  while (stablePolls < RESPONSE_STABLE_POLLS) {
    if (Date.now() - start > GENERATION_TIMEOUT_MS) {
      throw new Error('Timed out waiting for Gemini response to finish generating');
    }

    await sleep(RESPONSE_POLL_INTERVAL_MS);
    const currentText = await getLatestResponseText(page);

    if (currentText.length > 0 && currentText === lastText) {
      stablePolls++;
    } else {
      stablePolls = 0;
      lastText = currentText;
    }
  }

  if (!lastText) {
    throw new Error('Gemini web returned an empty response');
  }

  return lastText;
}

class GeminiWebSession {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private initPromise: Promise<void> | undefined;
  private operationQueue: Promise<unknown> = Promise.resolve();

  private async initialize(): Promise<void> {
    if (!fs.existsSync(USER_DATA_DIR)) {
      fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    }

    this.browser = await puppeteer.launch({
      headless: true,
      userDataDir: USER_DATA_DIR,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1366, height: 900 });
    await this.page.goto(GEMINI_APP_URL, { waitUntil: 'networkidle2', timeout: 60_000 });
    await ensureGeminiLogin(this.page);
  }

  async ensureReady(): Promise<Page> {
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }

    await this.initPromise;

    if (!this.page) {
      throw new Error('Gemini web session failed to initialize');
    }

    return this.page;
  }

  async generate(prompt: string): Promise<string> {
    const run = async (): Promise<string> => {
      const page = await this.ensureReady();
      const editorSelector = await waitForAnySelector(page, EDITOR_SELECTORS, 30_000);
      const responseCountBefore = await countResponses(page);

      await setEditorText(page, editorSelector, prompt);
      await sleep(300);
      await submitPrompt(page);
      await waitForNewResponse(page, responseCountBefore);

      return waitForResponseToFinish(page);
    };

    const result = this.operationQueue.then(run);
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
      this.page = undefined;
      this.initPromise = undefined;
    }
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
  sourceAI: GeminiWebSourceAi = 'gemini-web';

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
      return await getGeminiWebSession().generate(prompt);
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
