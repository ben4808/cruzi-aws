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

export function entryToAllCaps(entry: string): string {
    const uppercasePhrase = entry.toUpperCase();
    const lettersOnlyPhrase = uppercasePhrase.replace(/[^a-zA-Z\u00C0-\u017F]/g, "");
    const allcapsNoSpacesPhrase = lettersOnlyPhrase.replace(/\s/g, "");
    return allcapsNoSpacesPhrase;
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

export function stripAccents(text: string): string {
    return text.normalize('NFD').replace(/\p{M}/gu, '');
}

export function displayTextToEntry(text: string): string {
    // Convert display text to entry format
    // This regular expression now preserves a wide range of alphanumeric characters,
    // accented and tilded letters from various languages, and apostrophes.
    return text.replace(/[^a-zA-Z0-9áéíóúüñãõẽĩũỹÁÉÍÓÚÜÑÃÕẼĨŨỸ']/g, '').toUpperCase();
}

export function isGeminiTimeoutError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /timed out/i.test(message);
}
