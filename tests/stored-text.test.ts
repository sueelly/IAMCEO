import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { encodeStoredText, decodeStoredText } from "../server/stored-text.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("large text survives compression byte-for-byte including Korean, emoji and NUL", () => {
  const text = "한글 e\u0301 é 🐈\u0000\r\n".repeat(4000);
  const encoded = encodeStoredText(text);
  expect(encoded instanceof Uint8Array).toBe(true);
  expect(encoded.length).toBeLessThan(Buffer.byteLength(text) / 5);
  expect(decodeStoredText(encoded)).toBe(text);
});

test("legacy, small, invalid-UTF8-surrogate and incompressible strings stay exact TEXT", () => {
  for (const text of ["", "기존 자료\u0000", "\ud800".repeat(2000), randomBytes(500).toString("hex")]) {
    expect(encodeStoredText(text)).toBe(text);
    expect(decodeStoredText(text)).toBe(text);
  }
});

test("corrupt and unknown binary envelopes fail instead of returning damaged/empty text", () => {
  const encoded = encodeStoredText("압축 내용".repeat(4000)) as Uint8Array;
  const corrupt = Buffer.from(encoded);
  corrupt[corrupt.length - 5] ^= 255;
  expect(() => decodeStoredText(corrupt)).toThrow();
  const unknown = Buffer.from(encoded);
  unknown[6] = 255;
  expect(() => decodeStoredText(unknown)).toThrow();
  expect(() => decodeStoredText(encoded.slice(0, 10))).toThrow();
  expect(() => decodeStoredText(null)).toThrow();
});

test("SQLite TEXT and BLOB rows remain readable after reopening", () => {
  const runtime = createIsolatedRuntime();
  cleanups.push(() => runtime.stop());
  const path = join(runtime.paths.iamceoHome, "codec.db");
  let db = new Database(path, { create: true });
  const text = "원본 자료 <main>🐈</main>\n".repeat(800);
  db.exec("CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  db.query("INSERT INTO contents VALUES (1, ?), (2, ?)").run(encodeStoredText(text), "기존 본문");
  db.close();
  db = new Database(path, { readonly: true });
  cleanups.push(() => db.close());
  const rows = db.query<{ body: string | Uint8Array; kind: string }, []>("SELECT body, typeof(body) AS kind FROM contents ORDER BY id").all();
  expect(rows.map(r => r.kind)).toEqual(["blob", "text"]);
  expect(rows.map(r => decodeStoredText(r.body))).toEqual([text, "기존 본문"]);
});
