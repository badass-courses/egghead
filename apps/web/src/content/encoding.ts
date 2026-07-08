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

// A UTF-8 lead byte (0xC2-0xF4) read as latin1, followed by a continuation
// byte (0x80-0xBF) — the signature of double-encoded text.
const DOUBLE_ENCODED_PATTERN = /[\u00C2-\u00F4][\u0080-\u00BF]/;

function cp1252CharsToBytes(value: string) {
  let bytes = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    const byte = CP1252_BYTE_BY_CODE_POINT.get(codePoint);
    if (byte !== undefined) {
      bytes += String.fromCharCode(byte);
    } else if (codePoint > 0xff) {
      // A genuine non-Latin-1 character means the string is not pure
      // mojibake — reinterpreting it as latin1 bytes would corrupt it.
      return null;
    } else {
      bytes += char;
    }
  }
  return bytes;
}

export function repairDoubleEncodedUtf8(value: string) {
  const asBytes = cp1252CharsToBytes(value);
  if (asBytes === null || !DOUBLE_ENCODED_PATTERN.test(asBytes)) return value;
  const decoded = Buffer.from(asBytes, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? value : decoded;
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
