import { gzipSync, gunzipSync } from "node:zlib";

// Magic + envelope version + codec (1 = gzip), followed by the original UTF-8 length.
const MAGIC = Buffer.from([0x49, 0x41, 0x4d, 0x54, 0x58, 0x54, 1, 1]);
const HEADER_BYTES = MAGIC.length + 4;
const MAX_COMPRESSED_TEXT_BYTES = 64 * 1024 * 1024;

export function encodeStoredText(text: string): string | Uint8Array {
  const bytes = Buffer.from(text, "utf8");
  // UTF-8 replaces unpaired UTF-16 surrogates; retain those strings as TEXT.
  if (bytes.length < 1024 || bytes.length > MAX_COMPRESSED_TEXT_BYTES || bytes.toString("utf8") !== text) return text;
  const compressed = gzipSync(bytes);
  if (compressed.length + HEADER_BYTES > bytes.length - 32) return text;
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt32BE(bytes.length, MAGIC.length);
  return Buffer.concat([header, compressed]);
}

export function decodeStoredText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!(value instanceof Uint8Array)) throw new Error("지원하지 않는 저장 본문 형식입니다");
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length <= HEADER_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("지원하지 않거나 손상된 저장 본문 압축 형식입니다");
  }
  const expected = bytes.readUInt32BE(MAGIC.length);
  if (expected < 1024 || expected > MAX_COMPRESSED_TEXT_BYTES) throw new Error("저장 본문 압축 길이가 잘못되었습니다");
  const decoded = gunzipSync(bytes.subarray(HEADER_BYTES), { maxOutputLength: expected });
  const text = decoded.toString("utf8");
  if (decoded.length !== expected || !Buffer.from(text, "utf8").equals(decoded)) throw new Error("저장 본문 압축 검증에 실패했습니다");
  return text;
}
