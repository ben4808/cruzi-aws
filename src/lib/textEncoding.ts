/** Unicode code points for Windows-1252 characters outside ISO-8859-1. */
const WINDOWS_1252_UNICODE = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function isWindows1252OrIso8859_1(codePoint: number): boolean {
  return codePoint <= 0xff || WINDOWS_1252_UNICODE.has(codePoint);
}

/** Removes characters that cannot be represented in ISO-8859-1 or Windows-1252. */
export function stripNonWindows1252OrIso8859_1(text: string): string {
  let result = '';
  for (const ch of text) {
    const codePoint = ch.codePointAt(0)!;
    if (isWindows1252OrIso8859_1(codePoint)) {
      result += ch;
    }
  }
  return result;
}
