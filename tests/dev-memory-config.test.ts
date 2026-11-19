import { releaseTestDir, testTempDir } from "./fixtures/test-run-dirs";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as memory from "../server/integrations/dev-memory.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) releaseTestDir(home); });
function fixture(value?: unknown) {
  const home = testTempDir("iamceo-memory-config-", "/private/tmp");
  homes.push(home);
  const path = join(home, "development-memory.json"), keyFile = join(home, "gateway-key");
  if (value !== undefined) writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return { home, path, keyFile };
}

test("runtime home restores a missing launch environment without reading the key itself", () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ baseUrl: "http://127.0.0.1:8892/", keyFile: f.keyFile, projects: ["hq", "p_one", "p_one"] }));
  expect(memory.loadDevMemoryConfig({}, f.home)).toEqual({ baseUrl: "http://127.0.0.1:8892", keyFile: f.keyFile, projects: ["hq", "p_one"] });
  expect(existsSync(f.keyFile)).toBe(false);
});

test("complete environment takes precedence and never parses an invalid fallback file", () => {
  const f = fixture();
  writeFileSync(f.path, "not-json-do-not-read");
  expect(memory.loadDevMemoryConfig({ IAMCEO_MEMORY_URL: " https://fixture.tail1.ts.net:11443/ ",
    IAMCEO_MEMORY_KEY_FILE: ` ${f.keyFile} `, IAMCEO_MEMORY_PROJECTS: " p_second,hq,p_second, " }, f.home))
    .toEqual({ baseUrl: "https://fixture.tail1.ts.net:11443", keyFile: f.keyFile, projects: ["p_second", "hq"] });
  expect(readFileSync(f.path, "utf8")).toBe("not-json-do-not-read");
});

test("an absent file is unconfigured and does not create configuration or inspect another home", () => {
  const f = fixture();
  expect(memory.loadDevMemoryConfig({}, f.home)).toBeNull();
  expect(existsSync(f.path)).toBe(false);
});

test("partial or blank explicit credentials fail instead of silently using saved connection scope", () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ baseUrl: "http://127.0.0.1:8892", keyFile: f.keyFile, projects: ["p_saved"] }));
  for (const env of [{ IAMCEO_MEMORY_URL: "http://127.0.0.1:8892" }, { IAMCEO_MEMORY_KEY_FILE: f.keyFile },
    { IAMCEO_MEMORY_URL: "", IAMCEO_MEMORY_KEY_FILE: f.keyFile },
    { IAMCEO_MEMORY_URL: "http://127.0.0.1:8892", IAMCEO_MEMORY_KEY_FILE: " " },
    { IAMCEO_MEMORY_URL: "", IAMCEO_MEMORY_KEY_FILE: "" }]) {
    expect(() => memory.loadDevMemoryConfig(env, f.home)).toThrow(/개발 기억/);
  }
});

test("a lone legacy project environment does not replace the saved connection's project list", () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ baseUrl: "http://localhost:8892", keyFile: f.keyFile, projects: ["p_saved"] }));
  expect(memory.loadDevMemoryConfig({ IAMCEO_MEMORY_PROJECTS: "p_unrelated" }, f.home)?.projects).toEqual(["p_saved"]);
});

test("file edits are read on the next load without retaining obsolete project scope", () => {
  const f = fixture();
  const value = { baseUrl: "http://[::1]:8892", keyFile: f.keyFile, projects: ["p_first"] };
  writeFileSync(f.path, JSON.stringify(value));
  expect(memory.loadDevMemoryConfig({}, f.home)?.projects).toEqual(["p_first"]);
  writeFileSync(f.path, JSON.stringify({ ...value, projects: ["p_second"] }));
  expect(memory.loadDevMemoryConfig({}, f.home)?.projects).toEqual(["p_second"]);
});

test("invalid JSON and configuration shape cannot become a partially enabled connection", () => {
  const f = fixture();
  const valid = { baseUrl: "http://127.0.0.1:8892", keyFile: f.keyFile, projects: [] };
  for (const value of [null, [], "invalid", { baseUrl: valid.baseUrl, keyFile: f.keyFile }, { ...valid, baseUrl: null }, { ...valid, keyFile: "relative-key" },
    { ...valid, keyFile: "" }, { ...valid, projects: null }, { ...valid, projects: "p_one" },
    { ...valid, projects: [2] }, { ...valid, projects: ["p/foreign"] }, { ...valid, projects: [" "] },
    { ...valid, projects: ["a".repeat(94)] }, { ...valid, apiKey: "accidental-secret" }]) {
    writeFileSync(f.path, JSON.stringify(value));
    expect(() => memory.loadDevMemoryConfig({}, f.home)).toThrow(/개발 기억/);
  }
  writeFileSync(f.path, '{"apiKey":"private-value",oops');
  try { memory.loadDevMemoryConfig({}, f.home); throw new Error("unexpected acceptance"); }
  catch (error) {
    expect((error as Error).message).toContain("개발 기억");
    expect((error as Error).message).not.toContain("private-value");
    expect((error as Error).message).not.toBe("unexpected acceptance");
  }
});

test("URL errors reject public endpoints and credentials without echoing configuration values", () => {
  const f = fixture();
  for (const baseUrl of ["http://outside.example", "https://fixture.tail1.ts.net/path", "http://secret:credential@localhost:8892", "credential-without-url-format"]) {
    writeFileSync(f.path, JSON.stringify({ baseUrl, keyFile: f.keyFile, projects: [] }));
    let failure: Error | undefined;
    try { memory.loadDevMemoryConfig({}, f.home); } catch (error) { failure = error as Error; }
    expect(failure).toBeDefined();
    expect(failure!.message).toContain("개발 기억");
    expect(failure!.message).not.toContain(baseUrl);
    expect(failure!.message).not.toContain("credential");
  }
});

test("explicit connection validates the key path and project identifiers before use", () => {
  const f = fixture(), env = { IAMCEO_MEMORY_URL: "http://127.0.0.1:8892", IAMCEO_MEMORY_KEY_FILE: f.keyFile };
  expect(() => memory.loadDevMemoryConfig({ ...env, IAMCEO_MEMORY_KEY_FILE: "relative-key" }, f.home)).toThrow(/개발 기억/);
  expect(() => memory.loadDevMemoryConfig({ ...env, IAMCEO_MEMORY_PROJECTS: "p_ok,p/foreign" }, f.home)).toThrow(/개발 기억/);
  expect(memory.loadDevMemoryConfig(env, f.home)?.projects).toEqual([]);
});

test("read failure is distinguished from a missing file and relative runtime homes are rejected", () => {
  const f = fixture();
  mkdirSync(f.path);
  expect(() => memory.loadDevMemoryConfig({}, f.home)).toThrow(/개발 기억/);
  expect(() => memory.loadDevMemoryConfig({}, "relative-home")).toThrow(/개발 기억/);
});

test("legacy environment parser remains compatible for callers that intentionally use only it", () => {
  const f = fixture();
  expect(memory.devMemoryConfigFromEnv({ IAMCEO_MEMORY_URL: "http://127.0.0.1:8892" })).toBeNull();
  expect(memory.devMemoryConfigFromEnv({ IAMCEO_MEMORY_URL: "http://127.0.0.1:8892", IAMCEO_MEMORY_KEY_FILE: f.keyFile }))
    .toEqual({ baseUrl: "http://127.0.0.1:8892", keyFile: f.keyFile, projects: [] });
});
