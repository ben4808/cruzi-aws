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
