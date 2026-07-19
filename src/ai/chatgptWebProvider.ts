import * as dotenv from 'dotenv';
import puppeteer, { Browser, Page } from 'puppeteer';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import { getFamiliarityResults, getQualityResults } from './common';
import { IAiProvider } from './IAiProvider';

dotenv.config();

export type ChatgptWebSourceAi = 'chatgpt-web';

export type ChatgptWebOptions = {
  /** When set, overrides CHATGPT_WEB_HEADLESS. Defaults to true (headless). */
  headless?: boolean;
};

const CHATGPT_APP_URL = 'https://chatgpt.com/';

const EDITOR_SELECTORS = [
  // Desktop / ProseMirror contenteditable composer
  '#prompt-textarea',
  'div#prompt-textarea[contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][data-id="root"]',
  'div[contenteditable="true"][role="textbox"]',
  // Mobile / narrow-viewport native textarea composer
  '#mobile-composer-prompt',
  'textarea.wm-composer-textarea',
  'textarea[aria-label="Chat with ChatGPT"]',
  'textarea[name="prompt"][placeholder="Ask anything"]',
];

const RESPONSE_SELECTORS = [
  '[data-message-author-role="assistant"] .markdown',
  '[data-message-author-role="assistant"]',
  '[data-testid="conversation-turn-3"] .markdown',
  'article[data-testid^="conversation-turn"] .markdown',
];

const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send message"]',
  'button[aria-label="Send prompt"]',
];

const RESPONSE_STABLE_POLLS = 4;
const RESPONSE_POLL_INTERVAL_MS = 800;
const CHATGPT_GENERATION_TIMEOUT_MS = 30_000;
const PUPPETEER_OPERATION_TIMEOUT_MS = CHATGPT_GENERATION_TIMEOUT_MS;

const GENERATING_INDICATOR_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop"]',
];

const WAIT_LOG_INTERVAL_MS = 30_000;
const CHATGPT_EDITOR_WAIT_MS = 60_000;
const CHATGPT_ATTEMPTS_PER_ROUND = 3;
const CHATGPT_ROUND_COOLDOWN_MS = 10 * 60 * 1000;
const CHATGPT_MIN_REQUEST_INTERVAL_MS = 30_000;
const CLOUDFLARE_WAIT_MS = 60_000;

/** Realistic Chrome UA — default Puppeteer headless UA gets stuck on Cloudflare ("Just a moment..."). */
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function resolveChatgptWebHeadless(headless?: boolean): boolean {
  if (headless !== undefined) {
    return headless;
  }
  return process.env.CHATGPT_WEB_HEADLESS !== 'false';
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastChatgptRequestAt = 0;

async function waitForChatgptRequestSlot(): Promise<void> {
  const elapsed = Date.now() - lastChatgptRequestAt;
  if (lastChatgptRequestAt > 0 && elapsed < CHATGPT_MIN_REQUEST_INTERVAL_MS) {
    const waitMs = CHATGPT_MIN_REQUEST_INTERVAL_MS - elapsed;
    console.log(
      `Rate limiting ChatGPT requests: waiting ${Math.ceil(waitMs / 1000)}s before next request...`,
    );
    await sleep(waitMs);
  }
  lastChatgptRequestAt = Date.now();
}

async function prepareChatgptPage(page: Page): Promise<void> {
  await page.setUserAgent(CHROME_USER_AGENT);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });
}

async function waitForCloudflareChallenge(page: Page, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let logged = false;

  while (Date.now() - start < timeoutMs) {
    const title = await page.title().catch(() => '');
    if (!/just a moment/i.test(title)) {
      return;
    }
    if (!logged) {
      console.log('Waiting for Cloudflare challenge to clear...');
      logged = true;
    }
    await sleep(500);
  }

  throw new Error(
    'Timed out waiting for Cloudflare challenge. ChatGPT blocked this browser session.',
  );
}

/**
 * Dismiss login/signup/cookie overlays so guest chat works without signing in.
 * ChatGPT still shows the prompt editor behind these; we just need them out of the way.
 * Returns true if something was dismissed.
 */
async function dismissAuthOverlays(page: Page): Promise<boolean> {
  let anyDismissed = false;

  for (let attempt = 0; attempt < 6; attempt++) {
    const dismissed = await page.evaluate(() => {
      const clickable = Array.from(
        document.querySelectorAll('a, button, [role="button"], [role="link"]'),
      ) as HTMLElement[];

      const guestLabels = [
        /^stay logged out$/i,
        /^continue without (an )?account$/i,
        /^continue as guest$/i,
        /^use without (an )?account$/i,
        /^try without (an )?account$/i,
        /^skip$/i,
      ];

      for (const el of clickable) {
        const text = (el.innerText || el.textContent || '').trim();
        if (!text || text.length > 80) {
          continue;
        }
        if (guestLabels.some((re) => re.test(text))) {
          el.click();
          return `guest:${text}`;
        }
      }

      const closeSelectors = [
        'button[aria-label="Close"]',
        'button[aria-label="Dismiss"]',
        'button[data-testid="close-button"]',
        'button[data-testid="modal-close"]',
        '[data-testid="login-modal"] button[aria-label="Close"]',
      ];
      for (const selector of closeSelectors) {
        const close = document.querySelector(selector);
        if (close instanceof HTMLElement) {
          close.click();
          return `close:${selector}`;
        }
      }

      // Cookie / consent banners
      for (const el of clickable) {
        const text = (el.innerText || el.textContent || '').trim();
        if (/^(accept|accept all|agree|got it|ok|okay)$/i.test(text)) {
          const inBanner =
            el.closest('[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"]') !=
            null;
          if (inBanner) {
            el.click();
            return `cookie:${text}`;
          }
        }
      }

      return null;
    });

    if (!dismissed) {
      if (anyDismissed) {
        // Escape can close a leftover signup dialog after clicking guest/close.
        await page.keyboard.press('Escape');
        await sleep(300);
      }
      break;
    }

    anyDismissed = true;
    console.log(`Dismissed ChatGPT overlay (${dismissed})`);
    await sleep(500);
  }

  return anyDismissed;
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

async function waitForChatgptApp(page: Page): Promise<void> {
  await waitForCloudflareChallenge(page, CLOUDFLARE_WAIT_MS);

  const start = Date.now();
  while (Date.now() - start < CHATGPT_EDITOR_WAIT_MS) {
    await dismissAuthOverlays(page);
    const selector = await findFirstSelector(page, EDITOR_SELECTORS);
    if (selector) {
      return;
    }
    await sleep(250);
  }

  throw new Error(
    'ChatGPT prompt editor did not appear after dismissing login overlays. Guest access may be blocked in this region, or the page UI changed.',
  );
}

function stripChatgptWebUiChrome(text: string): string {
  return text
    .replace(/^ChatGPT said\s*\n?/i, '')
    .replace(/\n?Copy code\s*$/gim, '')
    .trim();
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

  return stripChatgptWebUiChrome(rawText);
}

async function isResponseGenerating(page: Page): Promise<boolean> {
  return page.evaluate(
    ({ stopSelectors, sendSelectors }) => {
      for (const selector of stopSelectors) {
        const element = document.querySelector(selector);
        if (element?.isConnected) {
          return true;
        }
      }

      for (const selector of sendSelectors) {
        const send = document.querySelector(selector);
        if (send instanceof HTMLButtonElement && send.disabled) {
          return true;
        }
      }

      return false;
    },
    {
      stopSelectors: GENERATING_INDICATOR_SELECTORS,
      sendSelectors: SEND_BUTTON_SELECTORS,
    },
  );
}

async function startNewChat(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    const byTestId = document.querySelector('[data-testid="create-new-chat-button"]');
    if (byTestId instanceof HTMLElement) {
      byTestId.click();
      return true;
    }

    const byAria = document.querySelector(
      '[aria-label="New chat"], [aria-label*="New chat"], [aria-label*="new chat"]',
    );
    if (byAria instanceof HTMLElement) {
      byAria.click();
      return true;
    }

    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    const newChat = candidates.find((element) => /^new chat$/i.test((element.textContent ?? '').trim()));
    if (newChat instanceof HTMLElement) {
      newChat.click();
      return true;
    }

    return false;
  });

  if (!clicked) {
    await page.goto(CHATGPT_APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForCloudflareChallenge(page, CLOUDFLARE_WAIT_MS);
  } else {
    await sleep(1000);
  }

  await dismissAuthOverlays(page);
  await waitForAnySelector(page, EDITOR_SELECTORS, 30_000);
}

async function getEditorText(page: Page, editorSelector: string): Promise<string> {
  return page.evaluate((selector) => {
    const editor = document.querySelector(selector);
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      return editor.value.trim();
    }
    return editor?.textContent?.trim() ?? '';
  }, editorSelector);
}

async function getEditorTextLength(page: Page, editorSelector: string): Promise<number> {
  return page.evaluate((selector) => {
    const editor = document.querySelector(selector);
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      return editor.value.length;
    }
    return editor?.textContent?.length ?? 0;
  }, editorSelector);
}

async function dispatchEditorInput(page: Page, editorSelector: string): Promise<void> {
  await page.evaluate((selector) => {
    const editor = document.querySelector(selector);
    if (editor instanceof HTMLElement) {
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
  }, editorSelector);
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

  await dispatchEditorInput(page, editorSelector);
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

  await dispatchEditorInput(page, editorSelector);

  const insertedLength = await getEditorTextLength(page, editorSelector);

  if (insertedLength < prompt.trim().length * 0.9) {
    await setEditorTextViaKeyboard(page, editorSelector, prompt);
  }

  const inserted = await getEditorText(page, editorSelector);

  if (!inserted) {
    throw new Error('Failed to insert prompt into ChatGPT editor');
  }
}

async function waitForSendButtonEnabled(page: Page): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const isEnabled = await page.evaluate((selectors) => {
      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (button instanceof HTMLButtonElement && !button.disabled) {
          return true;
        }
      }
      return false;
    }, SEND_BUTTON_SELECTORS);

    if (isEnabled) {
      return;
    }
    await sleep(200);
  }
}

async function submitPrompt(page: Page): Promise<void> {
  await waitForSendButtonEnabled(page);

  for (const selector of SEND_BUTTON_SELECTORS) {
    const sendButton = await page.$(selector);
    if (sendButton) {
      await sendButton.click();
      await sendButton.dispose();
      return;
    }
  }

  await page.keyboard.press('Enter');
}

async function waitForChatgptResponse(page: Page, timeoutMs: number): Promise<string> {
  let lastText = '';
  let stablePolls = 0;
  let sawActivity = false;
  const start = Date.now();
  let lastLogAt = start;

  while (stablePolls < RESPONSE_STABLE_POLLS) {
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      throw new Error(
        `Timed out after ${Math.round(elapsed / 1000)}s waiting for ChatGPT response (activity=${sawActivity}, textLength=${lastText.length})`,
      );
    }

    try {
      if (Date.now() - lastLogAt >= WAIT_LOG_INTERVAL_MS) {
        console.log(
          `Still waiting for ChatGPT response (${Math.round(elapsed / 1000)}s, activity=${sawActivity}, generating=${await isResponseGenerating(page)})...`,
        );
        lastLogAt = Date.now();
      }

      await dismissAuthOverlays(page);

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
        'ChatGPT page frame detached while waiting for response; waiting for frame to reattach...',
      );
      await waitForPageFrame(page, 15_000);
      await waitForAnySelector(page, EDITOR_SELECTORS, 30_000).catch(() => undefined);
      stablePolls = 0;
      lastText = '';
      sawActivity = false;
    }
  }

  if (!lastText) {
    throw new Error('ChatGPT web returned an empty response');
  }

  return lastText;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isResponseWaitTimeoutError(error: unknown): boolean {
  return /timed out/i.test(errorMessage(error));
}

function isDetachedFrameError(error: unknown): boolean {
  return /detached frame/i.test(errorMessage(error));
}

function isInsertPromptError(error: unknown): boolean {
  return /failed to insert prompt into chatgpt editor/i.test(errorMessage(error));
}

function describeChatgptSessionError(error: unknown): string {
  if (isDetachedFrameError(error)) {
    return 'page frame detached';
  }
  if (isInsertPromptError(error)) {
    return 'failed to insert prompt into editor';
  }
  if (isResponseWaitTimeoutError(error)) {
    return `response timed out after ${CHATGPT_GENERATION_TIMEOUT_MS / 1000}s`;
  }
  return errorMessage(error);
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
  throw new Error('Timed out waiting for ChatGPT page frame to reattach');
}

class ChatgptWebSession {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private pageSetup: Promise<void> | undefined;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private lastResponse: string | undefined;
  private readonly headless: boolean;

  constructor(private readonly workerId?: number, options?: ChatgptWebOptions) {
    this.headless = resolveChatgptWebHeadless(options?.headless);
  }

  private workerLabel(): string {
    return this.workerId == null ? 'default' : `worker-${this.workerId}`;
  }

  private async launchBrowser(): Promise<Browser> {
    if (this.browser) {
      return this.browser;
    }

    console.log(
      `Launching ChatGPT web browser (${this.workerLabel()}, headless=${this.headless})...`,
    );

    const browser = await puppeteer.launch({
      headless: this.headless,
      protocolTimeout: PUPPETEER_OPERATION_TIMEOUT_MS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    this.browser = browser;
    return browser;
  }

  private async ensurePage(): Promise<Page> {
    if (!this.pageSetup) {
      this.pageSetup = this.setupPage();
    }

    await this.pageSetup;

    if (!this.page) {
      throw new Error('ChatGPT web session failed to initialize page');
    }

    return this.page;
  }

  private async setupPage(): Promise<void> {
    const browser = await this.launchBrowser();
    const page = await browser.newPage();
    await page.setDefaultTimeout(PUPPETEER_OPERATION_TIMEOUT_MS);
    await page.setDefaultNavigationTimeout(60_000);
    await page.setViewport({ width: 1366, height: 900 });
    await prepareChatgptPage(page);
    await page.goto(CHATGPT_APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForChatgptApp(page);
    this.page = page;
    console.log(`ChatGPT web guest session ready (${this.workerLabel()})`);
  }

  private async restartBrowser(): Promise<void> {
    console.log(`Restarting ChatGPT web browser (${this.workerLabel()})...`);

    await this.page?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);

    this.browser = undefined;
    this.page = undefined;
    this.pageSetup = undefined;
  }

  private async generateOnce(prompt: string, attempt: number): Promise<string> {
    const page = await this.ensurePage();

    await startNewChat(page);
    await dismissAuthOverlays(page);

    const editorSelector = await waitForAnySelector(page, EDITOR_SELECTORS, 30_000);
    await setEditorText(page, editorSelector, prompt);
    await sleep(300);
    await waitForChatgptRequestSlot();
    await submitPrompt(page);

    console.log(
      `Waiting up to ${CHATGPT_GENERATION_TIMEOUT_MS / 1000}s for ChatGPT response (attempt ${attempt})...`,
    );
    return waitForChatgptResponse(page, CHATGPT_GENERATION_TIMEOUT_MS);
  }

  async generate(prompt: string): Promise<string> {
    const run = async (): Promise<string> => {
      let round = 1;

      while (true) {
        for (let attempt = 1; attempt <= CHATGPT_ATTEMPTS_PER_ROUND; attempt++) {
          const absoluteAttempt = (round - 1) * CHATGPT_ATTEMPTS_PER_ROUND + attempt;
          try {
            const response = await this.generateOnce(prompt, absoluteAttempt);

            if (response === this.lastResponse) {
              const isLastInRound = attempt >= CHATGPT_ATTEMPTS_PER_ROUND;
              console.warn(
                `ChatGPT returned the exact same reply as the previous request (attempt ${attempt}/${CHATGPT_ATTEMPTS_PER_ROUND} in round ${round}); ${
                  isLastInRound
                    ? `waiting ${CHATGPT_ROUND_COOLDOWN_MS / 60_000} minutes before next round...`
                    : 're-initializing ChatGPT web session and retrying...'
                }`,
              );
              continue;
            }

            this.lastResponse = response;
            return response;
          } catch (error) {
            // ChatGPT web UI is flaky — restart the browser and retry rather than
            // failing immediately on insert failures, timeouts, or other random errors.
            const isLastInRound = attempt >= CHATGPT_ATTEMPTS_PER_ROUND;
            const reason = describeChatgptSessionError(error);
            console.warn(
              `ChatGPT ${reason} (attempt ${attempt}/${CHATGPT_ATTEMPTS_PER_ROUND} in round ${round}); ${
                isLastInRound
                  ? `waiting ${CHATGPT_ROUND_COOLDOWN_MS / 60_000} minutes before next round...`
                  : 'restarting browser and retrying...'
              }`,
            );
          } finally {
            await this.restartBrowser();
          }
        }

        console.log(
          `ChatGPT round ${round} exhausted (${CHATGPT_ATTEMPTS_PER_ROUND} attempts). Cooling down for ${CHATGPT_ROUND_COOLDOWN_MS / 60_000} minutes...`,
        );
        await sleep(CHATGPT_ROUND_COOLDOWN_MS);
        round++;
      }
    };

    const result = this.operationQueue.then(run);
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);

    this.browser = undefined;
    this.page = undefined;
    this.pageSetup = undefined;
    this.operationQueue = Promise.resolve();
    this.lastResponse = undefined;
  }
}

const chatgptWebSessions = new Map<string, ChatgptWebSession>();

function sessionKeyForWorker(workerId?: number, headless?: boolean): string {
  const workerKey = workerId == null ? 'default' : `worker-${workerId}`;
  const resolvedHeadless = resolveChatgptWebHeadless(headless);
  return `${workerKey}:headless=${resolvedHeadless}`;
}

function getChatgptWebSession(workerId?: number, options?: ChatgptWebOptions): ChatgptWebSession {
  const key = sessionKeyForWorker(workerId, options?.headless);
  let session = chatgptWebSessions.get(key);
  if (!session) {
    session = new ChatgptWebSession(workerId, options);
    chatgptWebSessions.set(key, session);
  }
  return session;
}

export class ChatgptWebAiProvider implements IAiProvider {
  sourceAI: ChatgptWebSourceAi;
  private readonly workerId?: number;
  private readonly options?: ChatgptWebOptions;

  constructor(
    sourceAi: ChatgptWebSourceAi = 'chatgpt-web',
    workerId?: number,
    options?: ChatgptWebOptions,
  ) {
    this.sourceAI = sourceAi;
    this.workerId = workerId;
    this.options = options;
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
      return await getChatgptWebSession(this.workerId, this.options).generate(prompt);
    } catch (error) {
      console.error('Error calling ChatGPT web:', error);
      throw new Error(
        `Failed to generate AI response: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}

export async function closeChatgptWebSession(): Promise<void> {
  const sessions = [...chatgptWebSessions.values()];
  chatgptWebSessions.clear();
  await Promise.all(sessions.map((session) => session.close()));
}
