// Ported from xword-dl amuselabsdownloader.py (Apache-licensed kotwords deobfuscation)

function isValidKeyPrefix(rawc: string, keyPrefix: number[], spacing: number): boolean {
  try {
    let pos = 0;

    while (pos < rawc.length) {
      const startPos = pos;
      const chunk: string[] = [];
      let keyIndex = 0;

      while (keyIndex < keyPrefix.length && pos < rawc.length) {
        const chunkLength = Math.min(keyPrefix[keyIndex], rawc.length - pos);
        chunk.push(rawc.slice(pos, pos + chunkLength).split('').reverse().join(''));
        pos += chunkLength;
        keyIndex += 1;
      }

      const chunkStr = chunk.join('');
      const base64Start = Math.floor((startPos + 3) / 4) * 4 - startPos;
      const base64End = Math.floor(pos / 4) * 4 - startPos;

      if (base64Start >= chunkStr.length || base64End <= base64Start) {
        pos += spacing;
        continue;
      }

      const b64Chunk = chunkStr.slice(base64Start, base64End);

      try {
        const decoded = Buffer.from(b64Chunk, 'base64');
        for (const byte of decoded) {
          if (
            (byte < 32 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)
            || byte === 0xc0
            || byte === 0xc1
            || byte >= 0xf5
          ) {
            return false;
          }
        }
      } catch {
        return false;
      }

      pos += spacing;
    }

    return true;
  } catch {
    return false;
  }
}

function deobfuscateRawcWithKey(rawc: string, key: number[]): string {
  try {
    const buffer = rawc.split('');
    let i = 0;
    let segmentCount = 0;

    while (i < buffer.length - 1) {
      const segmentLength = Math.min(key[segmentCount % key.length], buffer.length - i);
      segmentCount += 1;

      let left = i;
      let right = i + segmentLength - 1;
      while (left < right) {
        [buffer[left], buffer[right]] = [buffer[right], buffer[left]];
        left += 1;
        right -= 1;
      }

      i += segmentLength;
    }

    return Buffer.from(buffer.join(''), 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

export function deobfuscateRawc(rawc: string): string {
  const yePos = rawc.indexOf('ye');
  const wePos = rawc.indexOf('we');

  const firstKeyDigit = Math.min(
    yePos === -1 ? rawc.length : yePos,
    wePos === -1 ? rawc.length : wePos,
  ) + 2;

  const candidateQueue: number[][] = firstKeyDigit > 20 ? [[]] : [[firstKeyDigit]];

  while (candidateQueue.length > 0) {
    const candidateKeyPrefix = candidateQueue.shift()!;

    if (candidateKeyPrefix.length === 7) {
      const deobfuscated = deobfuscateRawcWithKey(rawc, candidateKeyPrefix);
      try {
        JSON.parse(deobfuscated);
        return deobfuscated;
      } catch {
        continue;
      }
    }

    for (let nextDigit = 2; nextDigit <= 20; nextDigit += 1) {
      const newCandidate = [...candidateKeyPrefix, nextDigit];
      const remainingDigits = 7 - newCandidate.length;
      const minSpacing = 2 * remainingDigits;
      const maxSpacing = 20 * remainingDigits;

      let valid = false;
      for (let spacing = minSpacing; spacing <= maxSpacing; spacing += 1) {
        if (isValidKeyPrefix(rawc, newCandidate, spacing)) {
          valid = true;
          break;
        }
      }

      if (valid) {
        candidateQueue.push(newCandidate);
      }
    }
  }

  return '{}';
}
