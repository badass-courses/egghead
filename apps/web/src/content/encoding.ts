// Some imported rows hold double-encoded UTF-8: "Matías" was written as the
// latin1/cp1252 rendering of its UTF-8 bytes ("MatÃ­as"). Repair on read, and
// when filtering, match both the clean and double-encoded spellings.

// cp1252 maps bytes 0x80-0x9F to printable characters (curly quotes, dashes),
// so mojibake that passed through it holds these instead of C1 controls.
const CP1252_BYTE_BY_CODE_POINT = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

const CP1252_CODE_POINT_BY_BYTE = new Map<number, number>(
  [...CP1252_BYTE_BY_CODE_POINT].map(([codePoint, byte]) => [byte, codePoint]),
);

function byteFromMojibakeChar(char: string) {
  const codePoint = char.codePointAt(0) ?? 0;
  return CP1252_BYTE_BY_CODE_POINT.get(codePoint) ?? (codePoint <= 0xff ? codePoint : null);
}

function utf8SequenceLength(leadByte: number) {
  if (leadByte >= 0xc2 && leadByte <= 0xdf) return 2;
  if (leadByte >= 0xe0 && leadByte <= 0xef) return 3;
  if (leadByte >= 0xf0 && leadByte <= 0xf4) return 4;
  return 0;
}

function validUtf8Sequence(bytes: readonly number[]) {
  if (bytes.length < 2) return false;
  if (bytes.slice(1).some((byte) => byte < 0x80 || byte > 0xbf)) return false;

  const [leadByte, secondByte] = bytes;
  if (leadByte === 0xe0 && (secondByte ?? 0) < 0xa0) return false;
  if (leadByte === 0xed && (secondByte ?? 0) > 0x9f) return false;
  if (leadByte === 0xf0 && (secondByte ?? 0) < 0x90) return false;
  if (leadByte === 0xf4 && (secondByte ?? 0) > 0x8f) return false;
  return true;
}

export function repairDoubleEncodedUtf8(value: string) {
  const chars = Array.from(value);
  let repaired = "";

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? "";
    const leadByte = byteFromMojibakeChar(char);
    const sequenceLength = leadByte === null ? 0 : utf8SequenceLength(leadByte);
    const sequenceChars = chars.slice(index, index + sequenceLength);
    const sequenceBytes = sequenceChars.map(byteFromMojibakeChar);

    if (
      sequenceLength > 0 &&
      sequenceChars.length === sequenceLength &&
      sequenceBytes.every((byte): byte is number => byte !== null) &&
      validUtf8Sequence(sequenceBytes)
    ) {
      repaired += Buffer.from(sequenceBytes).toString("utf8");
      index += sequenceLength - 1;
    } else {
      repaired += char;
    }
  }

  return repaired;
}

export function doubleEncodedUtf8Variant(value: string) {
  const bytes = Buffer.from(value, "utf8").toString("latin1");
  let variant = "";
  for (const char of bytes) {
    const codePoint = CP1252_CODE_POINT_BY_BYTE.get(char.charCodeAt(0));
    variant += codePoint === undefined ? char : String.fromCodePoint(codePoint);
  }
  return variant;
}
