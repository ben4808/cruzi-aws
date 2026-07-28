import * as dotenv from 'dotenv';
import * as path from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { Entry, FamiliarityResult, QualityResult } from 'cruzi-models';
import {
  ensureWebshareProxiesLoaded,
  nextWebshareProxy,
  webshareProxyServerArg,
  WebshareProxy,
} from '../lib/webshareProxy';
import { getFamiliarityResults, getQualityResults } from './common';
import { IAiProvider } from './IAiProvider';

dotenv.config();

export type GeminiWebSourceAi = 'gemini-web';

export interface GeminiWebOptions {
  /** When set, overrides GEMINI_WEB_USE_WEBSHARE. Defaults to false (direct). */
  useWebshare?: boolean;
  /** When set, overrides GEMINI_WEB_HEADLESS. Defaults to true (headless). */
  headless?: boolean;
  /** When false, skips the 30s gap between Gemini requests. Defaults to true. */
  enforceMinRequestInterval?: boolean;
  /**
   * When true, uses installed Chrome with a persistent profile and expects a
   * one-time manual Google sign-in (avoids "browser may not be secure").
   * Overrides GEMINI_WEB_LOGIN. Defaults to false (guest).
   */
  login?: boolean;
  /**
   * When true (and login is also enabled), selects Flash + Extended thinking in
   * the Gemini model picker before each prompt. Ignored without login.
   * Overrides GEMINI_WEB_EXTENDED_FLASH. Defaults to false.
   */
  extendedFlash?: boolean;
}

const GEMINI_APP_URL = 'https://gemini.google.com/app';

const EDITOR_MARK_ATTR = 'data-gemini-prompt-editor';

/** Known Gemini prompt-composer selectors across desktop / mobile / regional UI variants. */
const EDITOR_SELECTORS = [
  'div.ql-editor',
  'rich-textarea div[contenteditable="true"]',
  'rich-textarea [contenteditable="true"]',
  '[aria-label="Enter a prompt here"]',
  '[aria-label="Ask Gemini"]',
  '[aria-label*="Enter a prompt"]',
  '[aria-label*="Ask Gemini"]',
  '[aria-label*="prompt here"]',
  '[placeholder*="Enter a prompt"]',
  '[placeholder*="Ask Gemini"]',
  '.text-input-field_textarea-inner',
  '.input-area textarea',
  'div[contenteditable="true"][role="textbox"]',
  '[role="textbox"][contenteditable="true"]',
  'textarea[aria-label*="prompt"]',
  'textarea[aria-label*="Ask"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="prompt"]',
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

const SEND_BUTTON_SELECTORS = [
  'button[aria-label="Send message"]',
  'button[aria-label="Send"]',
  'button[aria-label*="Send message"]',
  'button[aria-label*="Submit"]',
  'button.send-button',
  'button[data-test-id="send-button"]',
];

const RESPONSE_STABLE_POLLS = 4;
const RESPONSE_POLL_INTERVAL_MS = 800;
const GEMINI_GENERATION_TIMEOUT_MS = 30_000;
/** Extended thinking can take much longer than standard Flash. */
const GEMINI_EXTENDED_GENERATION_TIMEOUT_MS = 180_000;
const PUPPETEER_OPERATION_TIMEOUT_MS = GEMINI_EXTENDED_GENERATION_TIMEOUT_MS;

const GENERATING_INDICATOR_SELECTORS = [
  'button[aria-label="Stop response"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop"]',
  '[data-test-id="stop-button"]',
  'mat-icon[data-mat-icon-name="stop"]',
];

const WAIT_LOG_INTERVAL_MS = 30_000;
const GEMINI_EDITOR_WAIT_MS = 60_000;
const GEMINI_ATTEMPTS_PER_ROUND = 3;
const GEMINI_ROUND_COOLDOWN_MS = 10 * 60 * 1000;
const GEMINI_MIN_REQUEST_INTERVAL_MS = 60_000;
const GEMINI_INTERNET_TOAST_COOLDOWN_MS = 10 * 60 * 1000;
const INTERNET_CONNECTION_TOAST_PATTERN = /connection/i;
const INTERNET_CONNECTION_TOAST_ERROR = 'Gemini internet connection toast detected';
const USAGE_LIMIT_ERROR = 'Gemini API usage limit hit';
const USAGE_LIMIT_PATTERN =
  /you'?ve reached your (usage )?limit|reached (your|the) (usage )?limit|usage limit|quota (exceeded|reached)|limit (will|has) refresh|out of (usage|quota)|try again later.*(hour|hours|limit)|limit refreshes?/i;

/** Persistent Chrome profile used when login is enabled. Override with GEMINI_WEB_USER_DATA_DIR. */
const DEFAULT_GEMINI_CHROME_USER_DATA_DIR = path.resolve(process.cwd(), '.gemini-user-data');
const MANUAL_GEMINI_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MANUAL_GEMINI_LOGIN_LOG_INTERVAL_MS = 30_000;

const GEMINI_SIGN_IN_SELECTORS = [
  'a[aria-label="Sign in"]',
  'button[aria-label="Sign in"]',
  'a[aria-label*="Sign in"]',
  'button[aria-label*="Sign in"]',
  'a[data-test-id*="sign-in"]',
  'button[data-test-id*="sign-in"]',
];

const GEMINI_ACCOUNT_CHROME_SELECTORS = [
  'a[aria-label*="Google Account"]',
  'button[aria-label*="Google Account"]',
  'img[alt*="Google Account"]',
  '[aria-label*="Google Account"]',
];

const COOKIE_ACCEPT_LABELS = [
  /^accept all$/i,
  /^accept all cookies$/i,
  /^accept cookies$/i,
  /^allow all$/i,
  /^agree to all$/i,
  /^i agree$/i,
  /^agree$/i,
];

const TOAST_SELECTORS = [
  '[role="alert"]',
  '[role="status"]',
  'snack-bar-container',
  '.mdc-snackbar',
  '.mat-mdc-snack-bar-container',
  '[class*="snackbar"]',
  '[class*="toast"]',
  '[class*="Snackbar"]',
  '[class*="Toast"]',
];

function resolveGeminiWebHeadless(headless?: boolean): boolean {
  if (headless !== undefined) {
    return headless;
  }
  return process.env.GEMINI_WEB_HEADLESS !== 'false';
}

function resolveGeminiWebUseWebshare(useWebshare?: boolean): boolean {
  if (useWebshare !== undefined) {
    return useWebshare;
  }
  return process.env.GEMINI_WEB_USE_WEBSHARE === 'true';
}

function resolveGeminiWebEnforceMinRequestInterval(enforce?: boolean): boolean {
  if (enforce !== undefined) {
    return enforce;
  }
  return process.env.GEMINI_WEB_ENFORCE_MIN_REQUEST_INTERVAL !== 'false';
}

function resolveGeminiWebLogin(login?: boolean): boolean {
  if (login !== undefined) {
    return login;
  }
  return process.env.GEMINI_WEB_LOGIN === 'true';
}

/**
 * Extended Flash only applies when login is enabled (model picker requires a signed-in session).
 */
function resolveGeminiWebExtendedFlash(
  extendedFlash?: boolean,
  login?: boolean,
): boolean {
  if (!resolveGeminiWebLogin(login)) {
    return false;
  }
  if (extendedFlash !== undefined) {
    return extendedFlash;
  }
  return process.env.GEMINI_WEB_EXTENDED_FLASH === 'true';
}

function resolveGeminiChromeUserDataDir(): string {
  const fromEnv = process.env.GEMINI_WEB_USER_DATA_DIR?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return DEFAULT_GEMINI_CHROME_USER_DATA_DIR;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastGeminiRequestAt = 0;
let internetToastCooldownUntil = 0;

async function waitForGeminiRequestSlot(enforce: boolean): Promise<void> {
  if (enforce) {
    const elapsed = Date.now() - lastGeminiRequestAt;
    if (lastGeminiRequestAt > 0 && elapsed < GEMINI_MIN_REQUEST_INTERVAL_MS) {
      const waitMs = GEMINI_MIN_REQUEST_INTERVAL_MS - elapsed;
      console.log(
        `Rate limiting Gemini requests: waiting ${Math.ceil(waitMs / 1000)}s before next request...`,
      );
      await sleep(waitMs);
    }
  }
  lastGeminiRequestAt = Date.now();
}

async function waitOutInternetToastCooldown(): Promise<void> {
  const remainingMs = internetToastCooldownUntil - Date.now();
  if (remainingMs <= 0) {
    return;
  }

  console.warn(
    `Gemini internet connection toast cooldown active; waiting ${Math.ceil(remainingMs / 60_000)} minutes before retrying...`,
  );
  await sleep(remainingMs);
}

function triggerInternetToastCooldown(): void {
  internetToastCooldownUntil = Date.now() + GEMINI_INTERNET_TOAST_COOLDOWN_MS;
}

async function hasInternetConnectionToast(page: Page): Promise<boolean> {
  return page.evaluate(
    ({ selectors, patternSource }) => {
      const pattern = new RegExp(patternSource, 'i');

      for (const selector of selectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          const text = (element.textContent ?? '').trim();
          if (pattern.test(text)) {
            return true;
          }
        }
      }

      const bodyText = document.body?.innerText ?? '';
      return pattern.test(bodyText);
    },
    {
      selectors: TOAST_SELECTORS,
      patternSource: INTERNET_CONNECTION_TOAST_PATTERN.source,
    },
  );
}

async function assertNoInternetConnectionToast(page: Page): Promise<void> {
  if (await hasInternetConnectionToast(page)) {
    throw new Error(INTERNET_CONNECTION_TOAST_ERROR);
  }
}

async function hasUsageLimitMessage(page: Page): Promise<boolean> {
  return page.evaluate(
    ({ selectors, patternSource }) => {
      const pattern = new RegExp(patternSource, 'i');

      for (const selector of selectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          const text = (element.textContent ?? '').trim();
          if (pattern.test(text)) {
            return true;
          }
        }
      }

      const bodyText = document.body?.innerText ?? '';
      return pattern.test(bodyText);
    },
    {
      selectors: TOAST_SELECTORS,
      patternSource: USAGE_LIMIT_PATTERN.source,
    },
  );
}

async function assertNoUsageLimit(page: Page): Promise<void> {
  if (await hasUsageLimitMessage(page)) {
    throw new Error(USAGE_LIMIT_ERROR);
  }
}

function assertResponseNotUsageLimit(text: string): void {
  if (USAGE_LIMIT_PATTERN.test(text)) {
    throw new Error(USAGE_LIMIT_ERROR);
  }
}

async function findFirstSelector(page: Page, selectors: string[]): Promise<string | null> {
  for (const selector of selectors) {
    try {
      const handle = await page.$(selector);
      if (handle) {
        await handle.dispose();
        return selector;
      }
    } catch {
      // Invalid/unsupported selectors are skipped so regional CSS variants stay resilient.
    }
  }
  return null;
}

/**
 * Accept cookie / consent banners ("Accept all", etc.), including Google consent pages
 * that often appear behind regional Webshare IPs.
 */
async function acceptCookieConsent(page: Page): Promise<boolean> {
  let anyAccepted = false;

  for (let attempt = 0; attempt < 6; attempt++) {
    const accepted = await page.evaluate((labelSources) => {
      const labels = labelSources.map((source) => new RegExp(source, 'i'));

      function visible(el: Element): boolean {
        if (!(el instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function labelText(el: Element): string {
        if (!(el instanceof HTMLElement)) {
          return '';
        }
        return (
          el.getAttribute('aria-label')
          || el.innerText
          || el.textContent
          || ''
        ).trim().replace(/\s+/g, ' ');
      }

      const clickable = Array.from(
        document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]'),
      );

      // Prefer explicit "Accept all" style buttons anywhere on the page / consent form.
      for (const el of clickable) {
        if (!visible(el)) {
          continue;
        }
        const text = labelText(el);
        if (!text || text.length > 80) {
          continue;
        }
        if (labels.some((re) => re.test(text))) {
          (el as HTMLElement).click();
          return text;
        }
      }

      // Fallback: accept/agree inside cookie/consent containers.
      for (const el of clickable) {
        if (!visible(el)) {
          continue;
        }
        const text = labelText(el);
        if (!/^(accept|agree|allow|got it|ok|okay)$/i.test(text)) {
          continue;
        }
        const inBanner =
          el.closest(
            '[class*="cookie"], [id*="cookie"], [class*="consent"], [id*="consent"], form[action*="consent"]',
          ) != null;
        if (inBanner) {
          (el as HTMLElement).click();
          return text;
        }
      }

      return null;
    }, COOKIE_ACCEPT_LABELS.map((re) => re.source));

    if (!accepted) {
      break;
    }

    anyAccepted = true;
    console.log(`Accepted Gemini cookie/consent banner (${accepted})`);
    await sleep(500);
  }

  return anyAccepted;
}

/**
 * Find a usable prompt editor across Gemini UI variants.
 * Marks the chosen element so later typing/submit code can target a stable selector.
 */
async function findPromptEditor(page: Page): Promise<string | null> {
  await page.evaluate((markAttr) => {
    for (const el of Array.from(document.querySelectorAll(`[${markAttr}]`))) {
      el.removeAttribute(markAttr);
    }
  }, EDITOR_MARK_ATTR);

  const known = await findFirstSelector(page, EDITOR_SELECTORS);
  if (known) {
    const marked = await page.evaluate(
      ({ selector, markAttr }) => {
        function visible(el: Element): boolean {
          if (!(el instanceof HTMLElement)) {
            return false;
          }
          if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('disabled')) {
            return false;
          }
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width >= 40 && rect.height >= 16;
        }

        const matches = Array.from(document.querySelectorAll(selector));
        const el = matches.find((candidate) => visible(candidate));
        if (!(el instanceof HTMLElement)) {
          return false;
        }
        el.setAttribute(markAttr, '1');
        return true;
      },
      { selector: known, markAttr: EDITOR_MARK_ATTR },
    );
    if (marked) {
      return `[${EDITOR_MARK_ATTR}="1"]`;
    }
  }

  const found = await page.evaluate(
    ({ markAttr }) => {
      function visible(el: Element): boolean {
        if (!(el instanceof HTMLElement)) {
          return false;
        }
        if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('disabled')) {
          return false;
        }
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width >= 40 && rect.height >= 16;
      }

      function descriptor(el: Element): string {
        if (!(el instanceof HTMLElement)) {
          return '';
        }
        return [
          el.getAttribute('aria-label'),
          el.getAttribute('placeholder'),
          el.getAttribute('data-placeholder'),
          el.getAttribute('data-aria-label'),
          el.getAttribute('title'),
        ]
          .filter(Boolean)
          .join(' ');
      }

      const promptLike = /prompt|ask\s*gemini|ask\b|message|enter|type|chat|write/i;
      const candidates = Array.from(
        document.querySelectorAll(
          '[contenteditable="true"], textarea, [role="textbox"], rich-textarea, .ql-editor',
        ),
      );

      const scored: Array<{ el: HTMLElement; score: number; area: number }> = [];
      for (const candidate of candidates) {
        const el =
          candidate instanceof HTMLElement && candidate.matches('[contenteditable="true"], textarea, [role="textbox"]')
            ? candidate
            : (candidate.querySelector('[contenteditable="true"], textarea, [role="textbox"]') as HTMLElement | null);
        if (!el || !visible(el)) {
          continue;
        }

        const desc = descriptor(el) || descriptor(candidate);
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        let score = 0;
        if (promptLike.test(desc)) {
          score += 100;
        }
        // Prefer composers near the bottom of the viewport (Gemini chat input).
        if (rect.top > window.innerHeight * 0.45) {
          score += 30;
        }
        if (el.isContentEditable || el instanceof HTMLTextAreaElement) {
          score += 10;
        }
        score += Math.min(area / 2000, 25);
        scored.push({ el, score, area });
      }

      scored.sort((a, b) => b.score - a.score || b.area - a.area);
      const best = scored[0];
      if (!best || best.score < 10) {
        return null;
      }

      best.el.setAttribute(markAttr, '1');
      return true;
    },
    { markAttr: EDITOR_MARK_ATTR },
  );

  return found ? `[${EDITOR_MARK_ATTR}="1"]` : null;
}

async function waitForPromptEditor(page: Page, timeoutMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await acceptCookieConsent(page);
    // Feature / promo popups after login often cover the composer; dismiss with "Not now".
    await dismissPostLoginPrompts(page);
    const selector = await findPromptEditor(page);
    if (selector) {
      return selector;
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for Gemini prompt editor');
}

async function waitForGeminiApp(page: Page): Promise<void> {
  try {
    await waitForPromptEditor(page, GEMINI_EDITOR_WAIT_MS);
  } catch {
    throw new Error(
      'Gemini app prompt editor did not appear. Guest access may be blocked, a consent wall is blocking the UI, or the page UI changed.',
    );
  }
}

async function clickFirstMatching(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (!handle) {
      continue;
    }
    try {
      await handle.click();
      return true;
    } catch {
      // Element may be obscured or detached; try the next selector.
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }
  return false;
}

async function clickVisibleByText(page: Page, labels: RegExp[]): Promise<string | null> {
  return page.evaluate((labelSources) => {
    const patterns = labelSources.map((source) => new RegExp(source, 'i'));

    function visible(el: Element): boolean {
      if (!(el instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function labelText(el: Element): string {
      if (!(el instanceof HTMLElement)) {
        return '';
      }
      return (
        el.getAttribute('aria-label')
        || el.innerText
        || el.textContent
        || ''
      ).trim().replace(/\s+/g, ' ');
    }

    const clickable = Array.from(
      document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]'),
    );

    for (const el of clickable) {
      if (!visible(el)) {
        continue;
      }
      const text = labelText(el);
      if (!text || text.length > 80) {
        continue;
      }
      if (patterns.some((re) => re.test(text))) {
        (el as HTMLElement).click();
        return text;
      }
    }

    return null;
  }, labels.map((re) => re.source));
}

async function dismissPostLoginPrompts(page: Page): Promise<void> {
  // Only dismiss promo/consent chrome on Gemini itself — never on Google accounts pages.
  if (!/gemini\.google\.com/i.test(page.url())) {
    return;
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    await acceptCookieConsent(page);

    // Prefer "Not now" on new-feature / promo popups so the prompt editor is reachable.
    const clicked = await clickVisibleByText(page, [
      /^not now$/i,
      /^no thanks$/i,
      /^skip$/i,
      /^got it$/i,
      /^dismiss$/i,
      /^i agree$/i,
      /^accept$/i,
    ]);

    if (!clicked) {
      break;
    }

    console.log(`Dismissed Gemini post-login prompt (${clicked})`);
    await sleep(750);
  }
}

/** Mode/model picker trigger next to the Gemini prompt composer. */
const GEMINI_MODE_PICKER_SELECTORS = [
  'button[data-test-id="bard-mode-menu-button"]',
  '[data-test-id="bard-mode-menu-button"]',
  'button.input-area-switch',
  'button[aria-label*="Open mode picker"]',
  'button[aria-label*="mode picker"]',
];

/**
 * Opens the Gemini mode picker button (input-area "Flash" / mode switch).
 * Returns the label/selector used, or null if not found.
 */
async function openGeminiModePicker(page: Page): Promise<string | null> {
  return page.evaluate((selectors) => {
    function visible(el: Element): boolean {
      if (!(el instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function labelText(el: Element): string {
      if (!(el instanceof HTMLElement)) {
        return '';
      }
      return (
        el.getAttribute('aria-label')
        || el.innerText
        || el.textContent
        || ''
      ).trim().replace(/\s+/g, ' ');
    }

    // Prefer the known input-area mode picker (data-test-id="bard-mode-menu-button").
    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!visible(el)) {
          continue;
        }
        (el as HTMLElement).click();
        return labelText(el) || selector;
      }
    }

    // Fallback: other model/mode menu triggers (header or composer).
    const explicitSelectors = [
      'button[aria-label*="model" i]',
      'button[aria-label*="Model" i]',
      '[data-test-id*="model-selector"]',
      '[data-test-id*="mode-switcher"]',
      '[data-test-id*="mode-menu"]',
      'button[aria-haspopup="menu"]',
      'button[aria-haspopup="listbox"]',
    ];

    for (const selector of explicitSelectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!visible(el)) {
          continue;
        }
        const text = labelText(el);
        // Skip send / account / nav chrome.
        if (/send|account|settings|new chat|sign in/i.test(text) && !/flash|pro|thinking|fast|model|mode picker/i.test(text)) {
          continue;
        }
        if (/flash|pro|thinking|fast|gemini|model|mode picker/i.test(text) || /model|mode/i.test(selector)) {
          (el as HTMLElement).click();
          return text || selector;
        }
      }
    }

    // Fallback: any visible button whose label mentions Flash / mode picker.
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], [role="combobox"]'),
    );
    for (const el of candidates) {
      if (!visible(el)) {
        continue;
      }
      const text = labelText(el);
      if (!text || text.length > 80) {
        continue;
      }
      if (/mode picker/i.test(text) || /^(flash|fast|pro|thinking)$/i.test(text) || /\b(flash|fast|pro|thinking)\b/i.test(text)) {
        (el as HTMLElement).click();
        return text;
      }
    }

    return null;
  }, GEMINI_MODE_PICKER_SELECTORS);
}

/**
 * Reads the mode-picker trigger label (e.g. "Open mode picker, currently Flash").
 */
async function getModePickerLabel(page: Page): Promise<string | null> {
  return page.evaluate((selectors) => {
    function visible(el: Element): boolean {
      if (!(el instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!visible(el) || !(el instanceof HTMLElement)) {
          continue;
        }
        const text = (
          el.getAttribute('aria-label')
          || el.innerText
          || el.textContent
          || ''
        ).trim().replace(/\s+/g, ' ');
        if (text) {
          return text;
        }
      }
    }
    return null;
  }, GEMINI_MODE_PICKER_SELECTORS);
}

function isExtendedThinkingModeLabel(label: string | null): boolean {
  if (!label) {
    return false;
  }
  // Plain Flash / Fast should not count; Thinking / Extended should.
  if (/\bextended\b/i.test(label) || /\bthinking\b/i.test(label)) {
    return true;
  }
  return false;
}

/**
 * Clicks an option inside the open Gemini mode picker menu.
 * Menu items often use role=menuitem and include a title + subtitle
 * (e.g. "Extended thinking" / "Complex problem solving").
 */
async function clickModePickerOption(
  page: Page,
  options: { title: RegExp; subtitle?: RegExp },
): Promise<string | null> {
  return page.evaluate(
    ({ titleSource, subtitleSource }) => {
      const titleRe = new RegExp(titleSource, 'i');
      const subtitleRe = subtitleSource ? new RegExp(subtitleSource, 'i') : null;

      function visible(el: Element): boolean {
        if (!(el instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      function normalize(text: string): string {
        return text.trim().replace(/\s+/g, ' ');
      }

      function itemText(el: Element): string {
        if (!(el instanceof HTMLElement)) {
          return '';
        }
        // Prefer visible text over aria-label so title+subtitle rows match correctly.
        return normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
      }

      const itemSelectors = [
        '[role="menuitem"]',
        '[role="option"]',
        '[role="menuitemradio"]',
        'button[mat-menu-item]',
        '[mat-menu-item]',
        '.mat-mdc-menu-item',
        '.mat-menu-item',
        '[cdkmenuitem]',
        'button[role="menuitem"]',
        '.mat-mdc-menu-panel button',
        '.mat-menu-panel button',
        '.cdk-overlay-pane button',
      ];

      const seen = new Set<Element>();
      const candidates: HTMLElement[] = [];

      for (const selector of itemSelectors) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          if (seen.has(el) || !(el instanceof HTMLElement) || !visible(el)) {
            continue;
          }
          seen.add(el);
          candidates.push(el);
        }
      }

      // Prefer the most specific row: subtitle match, then shortest label (leaf item).
      const scored: Array<{ el: HTMLElement; text: string; score: number }> = [];
      for (const el of candidates) {
        const text = itemText(el);
        if (!text || text.length > 200) {
          continue;
        }
        if (!titleRe.test(text)) {
          continue;
        }
        // Skip wrappers that concatenate multiple mode rows (Flash + Extended + ...).
        if (/\bflash\b/i.test(text) && /extended\s*thinking/i.test(text) && text.length > 60) {
          continue;
        }

        let score = 1;
        if (subtitleRe && subtitleRe.test(text)) {
          score += 10;
        }
        // Prefer leaf rows over wrappers that include lots of unrelated text.
        score += Math.max(0, 40 - text.length) / 10;
        scored.push({ el, text, score });
      }

      scored.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
      const best = scored[0];
      if (!best) {
        return null;
      }

      best.el.click();
      return best.text;
    },
    {
      titleSource: options.title.source,
      subtitleSource: options.subtitle?.source,
    },
  );
}

/**
 * Opens the Gemini model picker and selects Extended thinking.
 * Requires a signed-in session; guest UI typically has no model/thinking controls.
 */
async function selectExtendedFlashMode(page: Page): Promise<void> {
  if (!/gemini\.google\.com/i.test(page.url())) {
    throw new Error('Cannot select Extended Flash mode: not on gemini.google.com');
  }

  await dismissPostLoginPrompts(page);

  // Already on Extended/Thinking — do not reopen the picker (avoids accidentally
  // clicking plain Flash afterward).
  const currentLabel = await getModePickerLabel(page);
  if (isExtendedThinkingModeLabel(currentLabel)) {
    console.log(`Gemini already in Extended thinking mode (${currentLabel})`);
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const openedPicker = await openGeminiModePicker(page);
    if (!openedPicker) {
      throw new Error('Could not open Gemini model picker to select Extended Flash');
    }

    console.log(`Opened Gemini model picker (${openedPicker}, attempt ${attempt})`);
    await sleep(700);

    // Only click Extended thinking — never plain Flash (that undoes this selection).
    let selectedExtended = await clickModePickerOption(page, {
      title: /extended\s*thinking/i,
      subtitle: /complex\s*problem\s*solving/i,
    });

    if (!selectedExtended) {
      selectedExtended = await clickModePickerOption(page, {
        title: /extended\s*thinking/i,
      });
    }

    if (!selectedExtended) {
      selectedExtended = await clickVisibleByText(page, [
        /extended\s*thinking.*complex\s*problem\s*solving/i,
        /extended\s*thinking/i,
      ]);
    }

    if (selectedExtended) {
      console.log(`Selected Gemini thinking mode (${selectedExtended})`);
      // Do not press Escape — it can cancel the just-chosen menu selection.
      await sleep(500);
      return;
    }

    // Close a stale open menu before retrying.
    await page.keyboard.press('Escape').catch(() => undefined);
    await sleep(300);
    console.warn(`Gemini Extended thinking option not found (attempt ${attempt}); retrying...`);
  }

  throw new Error('Could not select Extended thinking in Gemini model picker');
}

async function isGoogleAccountsPage(page: Page): Promise<boolean> {
  return /accounts\.google\.com/i.test(page.url());
}

/** True only for a visible Sign in CTA — not arbitrary accounts.google.com links. */
async function hasVisibleGeminiSignInButton(page: Page): Promise<boolean> {
  return page.evaluate((selectors) => {
    function visible(el: Element): boolean {
      if (!(el instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function labelText(el: Element): string {
      if (!(el instanceof HTMLElement)) {
        return '';
      }
      return (
        el.getAttribute('aria-label')
        || el.innerText
        || el.textContent
        || ''
      ).trim().replace(/\s+/g, ' ');
    }

    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!visible(el)) {
          continue;
        }
        const text = labelText(el);
        if (/sign in/i.test(text) || /log in/i.test(text)) {
          return true;
        }
      }
    }

    for (const el of Array.from(document.querySelectorAll('a, button, [role="button"]'))) {
      if (!visible(el)) {
        continue;
      }
      const text = labelText(el);
      if (/^sign in$/i.test(text) || /^log in$/i.test(text)) {
        return true;
      }
    }

    return false;
  }, GEMINI_SIGN_IN_SELECTORS);
}

async function hasLoggedInAccountChrome(page: Page): Promise<boolean> {
  return page.evaluate((selectors) => {
    function visible(el: Element): boolean {
      if (!(el instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (visible(el)) {
          return true;
        }
      }
    }

    return false;
  }, GEMINI_ACCOUNT_CHROME_SELECTORS);
}

async function resolveActiveLoginPage(browser: Browser, fallback: Page): Promise<Page> {
  const pages = await browser.pages();
  // Prefer the newest accounts/gemini tab — Google often finishes login on a redirected page.
  for (let i = pages.length - 1; i >= 0; i--) {
    const candidate = pages[i];
    const url = candidate.url();
    if (/accounts\.google\.com/i.test(url) || /gemini\.google\.com/i.test(url)) {
      return candidate;
    }
  }
  return fallback;
}

async function isGeminiSignedIn(page: Page): Promise<boolean> {
  if (await isGoogleAccountsPage(page)) {
    return false;
  }
  if (!/gemini\.google\.com/i.test(page.url())) {
    return false;
  }
  if (await hasVisibleGeminiSignInButton(page)) {
    return false;
  }

  if (await findPromptEditor(page)) {
    return true;
  }

  // Account avatar / Google Account control is enough once Sign in is gone.
  return hasLoggedInAccountChrome(page);
}

async function clickGeminiSignInButton(page: Page): Promise<boolean> {
  // Prefer exact visible "Sign in" text over broad href matches.
  const clickedText = await clickVisibleByText(page, [/^sign in$/i, /^log in$/i]);
  if (clickedText) {
    console.log(`Clicked Gemini Sign in button (${clickedText})`);
    return true;
  }

  if (await clickFirstMatching(page, GEMINI_SIGN_IN_SELECTORS)) {
    console.log('Clicked Gemini Sign in button');
    return true;
  }

  return false;
}

/**
 * Ensures a signed-in Gemini session using a persistent real Chrome profile.
 * Completes Google auth manually in the visible browser when needed (no password automation).
 * Returns the page that should be used after login (may switch tabs).
 */
async function loginToGemini(page: Page): Promise<Page> {
  const browser = page.browser();

  await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await acceptCookieConsent(page);
  await dismissPostLoginPrompts(page);

  if (await isGeminiSignedIn(page)) {
    console.log('Gemini session already signed in (persistent Chrome profile)');
    return page;
  }

  console.log(
    'Gemini login required. Complete Google sign-in in the Chrome window (profile is saved for next runs)...',
  );

  let openedSignIn = false;
  if (await hasVisibleGeminiSignInButton(page)) {
    openedSignIn = await clickGeminiSignInButton(page);
  }

  const start = Date.now();
  let lastLogAt = start;
  let sawAccountsPage = false;
  let activePage = page;

  while (Date.now() - start < MANUAL_GEMINI_LOGIN_TIMEOUT_MS) {
    activePage = await resolveActiveLoginPage(browser, activePage);

    try {
      await acceptCookieConsent(activePage);
      await dismissPostLoginPrompts(activePage);

      if (await isGoogleAccountsPage(activePage)) {
        sawAccountsPage = true;
      }

      // After Google redirects back, land on /app explicitly.
      if (
        sawAccountsPage
        && /gemini\.google\.com/i.test(activePage.url())
        && !/gemini\.google\.com\/app/i.test(activePage.url())
      ) {
        await activePage.goto(GEMINI_APP_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        });
        await acceptCookieConsent(activePage);
        await dismissPostLoginPrompts(activePage);
      }

      if (await isGeminiSignedIn(activePage)) {
        console.log('Gemini manual Google login completed');
        return activePage;
      }

      // If editor isn't ready yet but Sign in is gone and we're on /app, wait for it.
      if (
        /gemini\.google\.com\/app/i.test(activePage.url())
        && !(await hasVisibleGeminiSignInButton(activePage))
      ) {
        const editor = await findPromptEditor(activePage);
        if (editor || (await hasLoggedInAccountChrome(activePage))) {
          console.log('Gemini manual Google login completed');
          return activePage;
        }
      }

      // Re-open Sign in only if we never reached Google accounts and are still signed out.
      if (
        !sawAccountsPage
        && !openedSignIn
        && /gemini\.google\.com\/app/i.test(activePage.url())
        && (await hasVisibleGeminiSignInButton(activePage))
      ) {
        openedSignIn = await clickGeminiSignInButton(activePage);
      }

      if (Date.now() - lastLogAt >= MANUAL_GEMINI_LOGIN_LOG_INTERVAL_MS) {
        console.log(
          `Still waiting for manual Gemini sign-in (${Math.round((Date.now() - start) / 1000)}s, url=${activePage.url()})...`,
        );
        lastLogAt = Date.now();
      }
    } catch (error) {
      if (!isDetachedFrameError(error)) {
        throw error;
      }
      activePage = await resolveActiveLoginPage(browser, page);
    }

    await sleep(1000);
  }

  throw new Error(
    `Timed out after ${MANUAL_GEMINI_LOGIN_TIMEOUT_MS / 60_000} minutes waiting for manual Gemini sign-in in Chrome`,
  );
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
    ({ stopSelectors, sendSelectors }) => {
      for (const selector of stopSelectors) {
        const element = document.querySelector(selector);
        if (element?.isConnected) {
          return true;
        }
      }

      for (const selector of sendSelectors) {
        const send = document.querySelector(selector);
        if (send instanceof HTMLButtonElement) {
          return send.disabled;
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

  await waitForPromptEditor(page, 30_000);
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
    const isEnabled = await page.evaluate((selectors) => {
      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (button instanceof HTMLButtonElement) {
          return !button.disabled;
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
      await assertNoInternetConnectionToast(page);
      await assertNoUsageLimit(page);
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
      await waitForPromptEditor(page, 30_000).catch(() => undefined);
      stablePolls = 0;
      lastText = '';
      sawActivity = false;
    }
  }

  if (!lastText) {
    throw new Error('Gemini web returned an empty response');
  }

  assertResponseNotUsageLimit(lastText);
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

function isInternetConnectionToastError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(INTERNET_CONNECTION_TOAST_ERROR);
}

function isUsageLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(USAGE_LIMIT_ERROR);
}

function isRecoverableGeminiSessionError(error: unknown): boolean {
  return (
    isResponseWaitTimeoutError(error) ||
    isDetachedFrameError(error) ||
    isInternetConnectionToastError(error)
  );
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
  private browser: Browser | undefined;
  private page: Page | undefined;
  private pageSetup: Promise<void> | undefined;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private lastResponse: string | undefined;
  private activeProxy: WebshareProxy | undefined;
  private readonly useWebshare: boolean;
  private readonly headless: boolean;
  private readonly enforceMinRequestInterval: boolean;
  private readonly login: boolean;
  private readonly extendedFlash: boolean;

  constructor(options?: GeminiWebOptions) {
    this.useWebshare = resolveGeminiWebUseWebshare(options?.useWebshare);
    this.headless = resolveGeminiWebHeadless(options?.headless);
    this.enforceMinRequestInterval = resolveGeminiWebEnforceMinRequestInterval(
      options?.enforceMinRequestInterval,
    );
    this.login = resolveGeminiWebLogin(options?.login);
    this.extendedFlash = resolveGeminiWebExtendedFlash(options?.extendedFlash, options?.login);
    if (
      (options?.extendedFlash === true || process.env.GEMINI_WEB_EXTENDED_FLASH === 'true')
      && !this.login
    ) {
      console.warn(
        'Gemini extendedFlash requested but login is disabled; Extended Flash requires login and will be ignored',
      );
    }
  }

  private async launchBrowser(): Promise<Browser> {
    if (this.browser) {
      return this.browser;
    }

    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
    this.activeProxy = undefined;

    // Logged-in sessions need a visible real Chrome window for the one-time manual sign-in.
    const headless = this.login ? false : this.headless;

    if (this.useWebshare) {
      await ensureWebshareProxiesLoaded();
      this.activeProxy = nextWebshareProxy();
      args.push(`--proxy-server=${webshareProxyServerArg(this.activeProxy)}`);
      console.log(
        `Launching Gemini web browser via Webshare proxy ${this.activeProxy.host}:${this.activeProxy.port} (headless=${headless}, login=${this.login})...`,
      );
    } else {
      console.log(
        `Launching Gemini web browser (direct, headless=${headless}, login=${this.login})...`,
      );
    }

    if (this.login) {
      args.push('--disable-blink-features=AutomationControlled');
      const userDataDir = resolveGeminiChromeUserDataDir();
      console.log(`Using persistent Chrome profile at ${userDataDir}`);

      const browser = await puppeteer.launch({
        channel: 'chrome',
        headless,
        userDataDir,
        protocolTimeout: PUPPETEER_OPERATION_TIMEOUT_MS,
        ignoreDefaultArgs: ['--enable-automation'],
        args,
      });

      this.browser = browser;
      return browser;
    }

    const browser = await puppeteer.launch({
      headless,
      protocolTimeout: PUPPETEER_OPERATION_TIMEOUT_MS,
      args,
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
      throw new Error('Gemini web session failed to initialize page');
    }

    return this.page;
  }

  private async setupPage(): Promise<void> {
    const browser = await this.launchBrowser();
    let page = await browser.newPage();
    await page.setDefaultTimeout(PUPPETEER_OPERATION_TIMEOUT_MS);
    await page.setDefaultNavigationTimeout(60_000);
    await page.setViewport({ width: 1366, height: 900 });

    if (this.activeProxy) {
      await page.authenticate({
        username: this.activeProxy.username,
        password: this.activeProxy.password,
      });
    }

    await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await acceptCookieConsent(page);
    if (this.login) {
      page = await loginToGemini(page);
      await page.setDefaultTimeout(PUPPETEER_OPERATION_TIMEOUT_MS);
      await page.setDefaultNavigationTimeout(60_000);
    }
    await waitForGeminiApp(page);
    if (this.extendedFlash) {
      await selectExtendedFlashMode(page);
    }
    this.page = page;
    const modeLabel = this.extendedFlash ? 'Extended Flash' : 'Flash';
    console.log(
      this.login
        ? this.useWebshare
          ? `Gemini web logged-in session ready (${modeLabel}, via Webshare)`
          : `Gemini web logged-in session ready (${modeLabel})`
        : this.useWebshare
          ? `Gemini web guest session ready (${modeLabel}, via Webshare)`
          : `Gemini web guest session ready (${modeLabel})`,
    );
  }

  private async restartBrowser(): Promise<void> {
    console.log('Restarting Gemini web browser...');

    await this.page?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);

    this.browser = undefined;
    this.page = undefined;
    this.pageSetup = undefined;
    this.activeProxy = undefined;
  }

  private async generateOnce(prompt: string, attempt: number): Promise<string> {
    await waitOutInternetToastCooldown();

    const page = await this.ensurePage();

    await startNewChat(page);

    if (this.extendedFlash) {
      await selectExtendedFlashMode(page);
    }

    const editorSelector = await waitForPromptEditor(page, 30_000);
    await setEditorText(page, editorSelector, prompt);
    await sleep(300);
    await waitForGeminiRequestSlot(this.enforceMinRequestInterval);
    await submitPrompt(page);
    await sleep(500);
    await assertNoInternetConnectionToast(page);
    await assertNoUsageLimit(page);

    const timeoutMs = this.extendedFlash
      ? GEMINI_EXTENDED_GENERATION_TIMEOUT_MS
      : GEMINI_GENERATION_TIMEOUT_MS;
    const modeLabel = this.extendedFlash ? 'Extended Flash' : 'Flash';
    console.log(
      `Waiting up to ${timeoutMs / 1000}s for Gemini ${modeLabel} response (attempt ${attempt})...`,
    );
    return waitForGeminiResponse(page, timeoutMs);
  }

  async generate(prompt: string): Promise<string> {
    const run = async (): Promise<string> => {
      let round = 1;

      while (true) {
        for (let attempt = 1; attempt <= GEMINI_ATTEMPTS_PER_ROUND; attempt++) {
          const absoluteAttempt = (round - 1) * GEMINI_ATTEMPTS_PER_ROUND + attempt;
          let internetToastHit = false;

          try {
            const response = await this.generateOnce(prompt, absoluteAttempt);

            if (response === this.lastResponse) {
              const isLastInRound = attempt >= GEMINI_ATTEMPTS_PER_ROUND;
              console.warn(
                `Gemini returned the exact same reply as the previous request (attempt ${attempt}/${GEMINI_ATTEMPTS_PER_ROUND} in round ${round}); ${
                  isLastInRound
                    ? `waiting ${GEMINI_ROUND_COOLDOWN_MS / 60_000} minutes before next round...`
                    : 're-initializing Gemini web session and retrying...'
                }`,
              );
              await this.restartBrowser();
              continue;
            }

            this.lastResponse = response;
            return response;
          } catch (error) {
            if (isUsageLimitError(error)) {
              throw error;
            }

            if (isInternetConnectionToastError(error)) {
              internetToastHit = true;
              triggerInternetToastCooldown();
              console.warn(
                `Gemini internet connection toast detected; waiting ${GEMINI_INTERNET_TOAST_COOLDOWN_MS / 60_000} minutes before next attempt...`,
              );
            } else if (!isRecoverableGeminiSessionError(error)) {
              throw error;
            } else {
              const isLastInRound = attempt >= GEMINI_ATTEMPTS_PER_ROUND;
              const generationTimeoutMs = this.extendedFlash
                ? GEMINI_EXTENDED_GENERATION_TIMEOUT_MS
                : GEMINI_GENERATION_TIMEOUT_MS;
              const reason = isDetachedFrameError(error)
                ? 'page frame detached'
                : `response timed out after ${generationTimeoutMs / 1000}s`;
              console.warn(
                `Gemini ${reason} (attempt ${attempt}/${GEMINI_ATTEMPTS_PER_ROUND} in round ${round}); ${
                  isLastInRound
                    ? `waiting ${GEMINI_ROUND_COOLDOWN_MS / 60_000} minutes before next round...`
                    : 'restarting browser and retrying...'
                }`,
              );
            }

            await this.restartBrowser();
          }

          if (internetToastHit) {
            await waitOutInternetToastCooldown();
          }
        }

        console.log(
          `Gemini round ${round} exhausted (${GEMINI_ATTEMPTS_PER_ROUND} attempts). Cooling down for ${GEMINI_ROUND_COOLDOWN_MS / 60_000} minutes...`,
        );
        await sleep(GEMINI_ROUND_COOLDOWN_MS);
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
    this.activeProxy = undefined;
    this.operationQueue = Promise.resolve();
    this.lastResponse = undefined;
  }
}

const geminiWebSessions = new Map<string, GeminiWebSession>();

function sessionKeyForOptions(options?: GeminiWebOptions): string {
  return [
    `useWebshare=${resolveGeminiWebUseWebshare(options?.useWebshare)}`,
    `headless=${resolveGeminiWebHeadless(options?.headless)}`,
    `enforceMinRequestInterval=${resolveGeminiWebEnforceMinRequestInterval(options?.enforceMinRequestInterval)}`,
    `login=${resolveGeminiWebLogin(options?.login)}`,
    `extendedFlash=${resolveGeminiWebExtendedFlash(options?.extendedFlash, options?.login)}`,
  ].join(':');
}

function getGeminiWebSession(options?: GeminiWebOptions): GeminiWebSession {
  const key = sessionKeyForOptions(options);
  let session = geminiWebSessions.get(key);
  if (!session) {
    session = new GeminiWebSession(options);
    geminiWebSessions.set(key, session);
  }
  return session;
}

export class GeminiWebAiProvider implements IAiProvider {
  sourceAI: GeminiWebSourceAi = 'gemini-web';
  private readonly options?: GeminiWebOptions;

  constructor(options?: GeminiWebOptions) {
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
      return await getGeminiWebSession(this.options).generate(prompt);
    } catch (error) {
      console.error('Error calling Gemini web:', error);
      throw new Error(
        `Failed to generate AI response: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}

export async function closeGeminiWebSession(): Promise<void> {
  const sessions = Array.from(geminiWebSessions.values());
  geminiWebSessions.clear();
  await Promise.all(sessions.map((session) => session.close()));
}
