import type { IAiProvider } from '../ai/IAiProvider';

// https://stackoverflow.com/questions/38416020/deep-copy-in-es6-using-the-spread-syntax
export function deepClone(obj: any): any {
    if(typeof obj !== 'object' || obj === null) {
        return obj;
    }

    if(obj instanceof Date) {
        return new Date(obj.getTime());
    }

    if(obj instanceof Map) {
        return new Map(Array.from(obj.entries()));
    }

    if(obj instanceof Array) {
        return obj.reduce((arr, item, i) => {
            arr[i] = deepClone(item);
            return arr;
        }, []);
    }

    if(obj instanceof Object) {
        return Object.keys(obj).reduce((newObj: any, key) => {
            newObj[key] = deepClone(obj[key]);
            return newObj;
        }, {})
    }
}

export function mapKeys<TKey, TVal>(map: Map<TKey, TVal>): TKey[] {
    return Array.from(map.keys()) || [];
}

export function mapValues<TKey, TVal>(map: Map<TKey, TVal>): TVal[] {
    return Array.from(map.values()) || [];
}

export const PUZZLE_TIMEZONE = 'America/New_York';

/** Calendar date as local midnight from year/month/day components. */
export function toCalendarDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Calendar date in the puzzle timezone (America/New_York) as local midnight. */
export function toPuzzleTimezoneCalendarDate(instant: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PUZZLE_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(instant);

  const year = Number(parts.find((part) => part.type === 'year')!.value);
  const month = Number(parts.find((part) => part.type === 'month')!.value) - 1;
  const day = Number(parts.find((part) => part.type === 'day')!.value);

  return new Date(year, month, day);
}

export function epochMsToPuzzleCalendarDate(epochMs: number): Date {
  return toPuzzleTimezoneCalendarDate(new Date(epochMs));
}

/** Parse an ISO datetime and return its calendar date in the puzzle timezone. */
export function isoDatetimeToPuzzleCalendarDate(datetime: string): Date {
  return toPuzzleTimezoneCalendarDate(new Date(datetime));
}

/** Most recent Sunday on or before the given calendar date. */
export function getMostRecentSunday(date: Date): Date {
  const calendarDate = toCalendarDate(date);
  const daysSinceSunday = calendarDate.getDay();
  if (daysSinceSunday === 0) {
    return calendarDate;
  }

  calendarDate.setDate(calendarDate.getDate() - daysSinceSunday);
  return calendarDate;
}

export function getPuzzleDate(now: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PUZZLE_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);

  const year = Number(parts.find((part) => part.type === 'year')!.value);
  const month = Number(parts.find((part) => part.type === 'month')!.value) - 1;
  const day = Number(parts.find((part) => part.type === 'day')!.value);

  return new Date(year, month, day);
}

export function formatDateKey(date: Date): string {
  const calendarDate = toCalendarDate(date);
  const year = calendarDate.getFullYear();
  const month = String(calendarDate.getMonth() + 1).padStart(2, '0');
  const day = String(calendarDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDateKey2(date: Date): string {
    const year = date.getFullYear().toString().slice(2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

export function formatDateKeyYYYYMMDD(date: Date): string {
  const year = date.getFullYear().toString();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

export function parseDateFromURL (date: string | null): Date {
  if (!date) {
    return new Date(); // Return current date if no date is provided
  }
  let parts = date.split('-');
  let year = parseInt(parts[0]);
  let month = parseInt(parts[1]) - 1; // Months are zero-based in JavaScript
  let day = parseInt(parts[2]);
  return new Date(year, month, day);
}

export function batchArray<T>(array: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function getRandomInt(max: number) {
    return Math.floor(Math.random() * max);
}

export function generateId(): string {
    let charPool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
    let id = "";
    for (let i=0; i<11; i++) {
        id += charPool[getRandomInt(64)];
    }
    return id;
}

/**
 * Normalize text to an entry key: uppercase ASCII letters and numerals only.
 * Accents/diacritics are stripped (e.g. "jalapeño" → "JALAPENO"); spaces and
 * punctuation are removed. Numerals are preserved (e.g. "catch-22" → "CATCH22").
 */
export function entryToAllCaps(entry: string): string {
    return stripAccents(entry)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
};

export function zipArraysFlat<T, U>(arr1: T[], arr2: U[]): (T | U)[] {
    const result: (T | U)[] = [];
    const minLength = Math.min(arr1.length, arr2.length);
    
    for (let i = 0; i < minLength; i++) {
        result.push(arr1[i], arr2[i]);
    }
    
    return result;
}

export function arrayToMap<T>(array: T[], keyFn: (item: T) => string): Map<string, T> {
    return array.reduce((map, item) => {
        map.set(keyFn(item), item);
        return map;
    }, new Map<string, T>());
}

/** Latin letters that don't fully decompose via NFD → ASCII base (aligned with DB normalize_display_text_to_entry_key). */
const ACCENT_FROM =
  'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝŸàáâãäåæçèéêëìíîïðñòóôõöøùúûüýÿāăąćĉċčďđēĕėęěĝğġģĥħĩīĭįıĵķĺļľŀłńņňŋōŏőœŕřśŝşšţťŧũūŭůűųŵŷỹẽĨŨỸ';
const ACCENT_TO =
  'AAAAAAACEEEEIIIIDNOOOOOOUUUUYYaaaaaaaceeeeiiiidnoooooouuuuyyaaaccccddeeeeegggghhiiiiijklllllnnnnoooorrsssstttuuuuuuwyyeIUY';

const ACCENT_MAP = new Map<string, string>(
  [...ACCENT_FROM].map((ch, i) => [ch, ACCENT_TO[i]]),
);

/**
 * Strip accents/diacritics for entry-key comparison.
 * Display text may keep accents (jalapeño); normalized entries do not (JALAPENO).
 */
export function stripAccents(text: string): string {
    const nfdStripped = text.normalize('NFD').replace(/\p{M}/gu, '');
    let result = '';
    for (const ch of nfdStripped) {
        result += ACCENT_MAP.get(ch) ?? ch;
    }
    return result;
}

/**
 * Convert display text to a normalized entry key.
 * Display text may include accents (jalapeño); the entry key does not (JALAPENO).
 * Numerals are preserved.
 */
export function displayTextToEntry(text: string): string {
    return entryToAllCaps(text);
}

export const AI_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Timeout for the entry parser, unity, familiarity, and quality generators. */
export const GENERATOR_AI_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export class AiRequestTimeoutError extends Error {
    constructor(timeoutMs: number = AI_REQUEST_TIMEOUT_MS) {
        super(`AI request timed out after ${timeoutMs / 1000}s`);
        this.name = 'AiRequestTimeoutError';
    }
}

export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number = AI_REQUEST_TIMEOUT_MS,
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new AiRequestTimeoutError(timeoutMs));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
        }
    }
}

export function isGeminiTimeoutError(error: unknown): boolean {
    if (error instanceof AiRequestTimeoutError) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /timed out/i.test(message);
}

/** Thrown when an AI provider request fails for any reason other than a timeout (HTTP error, etc.). */
export class AiRequestFailedError extends Error {
    constructor(cause: unknown) {
        const causeMessage = cause instanceof Error ? cause.message : String(cause);
        super(`AI request failed: ${causeMessage}`);
        this.name = 'AiRequestFailedError';
        (this as { cause?: unknown }).cause = cause;
    }
}

/**
 * True for errors that mean "this AI request should be abandoned and the script should
 * move on": timeouts and any other failure of the AI provider request itself.
 */
export function isAbandonableAiError(error: unknown): boolean {
    return error instanceof AiRequestFailedError || isGeminiTimeoutError(error);
}

/** How long the generators wait before sending the next batch after an unauthorized AI error. */
export const UNAUTHORIZED_AI_WAIT_MS = 15 * 60 * 1000;

/**
 * True if the error (or anything in its cause chain) looks like an unauthorized /
 * authentication failure from the AI provider (HTTP 401/403, AuthenticationError, etc.).
 */
export function isUnauthorizedAiError(error: unknown): boolean {
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current && !seen.has(current)) {
        seen.add(current);
        const err = current as { name?: unknown; status?: unknown; message?: unknown; cause?: unknown };
        if (err.status === 401 || err.status === 403 || err.name === 'AuthenticationError') {
            return true;
        }
        const message = current instanceof Error ? current.message : String(err.message ?? current);
        if (/unauthori[sz]ed|\b(401|403)\b|authentication (failed|error)|invalid api key|forbidden/i.test(message)) {
            return true;
        }
        current = err.cause;
    }
    return false;
}

export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits UNAUTHORIZED_AI_WAIT_MS if any of the errors is an unauthorized AI error.
 * Returns true if it waited.
 */
export async function waitIfUnauthorized(errors: unknown[], label: string): Promise<boolean> {
    if (!errors.some(isUnauthorizedAiError)) {
        return false;
    }
    console.warn(
        `${label}: unauthorized error from AI provider; waiting ${UNAUTHORIZED_AI_WAIT_MS / 60000} minutes ` +
            `before sending the next batch of requests...`,
    );
    await sleep(UNAUTHORIZED_AI_WAIT_MS);
    console.log(`${label}: resuming after unauthorized wait`);
    return true;
}

/**
 * Wraps a provider so any error from generateResultsAsync (other than a timeout, which is
 * passed through unchanged) is rethrown as an AiRequestFailedError. This lets callers tell
 * AI request failures apart from unrelated errors such as database failures.
 */
export function withAiFailureHandling(provider: IAiProvider): IAiProvider {
    return new Proxy(provider, {
        get(target, prop) {
            if (prop === 'generateResultsAsync') {
                return async (...args: Parameters<IAiProvider['generateResultsAsync']>) => {
                    try {
                        return await target.generateResultsAsync(...args);
                    } catch (error) {
                        if (isGeminiTimeoutError(error)) {
                            throw error;
                        }
                        throw new AiRequestFailedError(error);
                    }
                };
            }

            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
