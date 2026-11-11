import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as client from "../web/src/lib/api";

const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const originalFetch = globalThis.fetch;
const calls: { path: string; method: string; headers: Headers; body: unknown }[] = [];
let release401: (() => void) | null = null;
let wait401 = false;
let captured401: (() => void) | null = null;
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const url = new URL(req.url);
  calls.push({ path: url.pathname + url.search, method: req.method, headers: req.headers, body: await req.json().catch(() => null) });
  if (url.pathname === "/api/realtime-session" || url.pathname === "/api/files-session") return new Response(null, { status: 204 });
  if (wait401 && (url.pathname === "/api/bootstrap" || url.pathname === "/files/old")) {
    const wait = new Promise<void>(resolve => { release401 = resolve; });
    captured401?.();
    await wait;
    return Response.json({ error: "old request" }, { status: 401 });
  }
  if (url.pathname === "/api/settings") return Response.json({ error: "review again" }, { status: 409 });
  return Response.json({ ok: true });
} });
const base = `http://127.0.0.1:${listener.port}`;

beforeAll(() => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL(base) });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => originalFetch(typeof input === "string" ? new URL(input, base) : input, init)) as typeof fetch;
});
beforeEach(() => { calls.length = 0; wait401 = false; client.setAccessCode("fixture-private-code"); });
afterAll(() => {
  globalThis.fetch = originalFetch;
  client.setUnauthorizedHandler(() => {});
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
  listener.stop(true);
});

test("v2 browser transport uses cookie minting and never puts credentials in websocket URL", async () => {
  await client.api.realtimeSession();
  await client.api.capabilities();
  await client.api.sync("p /한글");
  expect(calls.map(call => [call.method, call.path])).toEqual([
    ["POST", "/api/realtime-session"], ["GET", "/api/capabilities"], ["GET", `/api/sync?projectId=${encodeURIComponent("p /한글")}`],
  ]);
  expect(calls.every(call => call.headers.get("authorization") === "Bearer fixture-private-code")).toBe(true);
  expect(client.wsUrl(2)).toBe(`ws://127.0.0.1:${listener.port}/ws?v=2`);
  expect(client.wsUrl()).toContain("?t=fixture-private-code");
});

test("cursor history and message reconciliation preserve opaque IDs and scope", async () => {
  await client.api.messagePage("p/1", { scope: { kind: "member", memberId: "m/1" }, cursor: "a+/=opaque", limit: 100 });
  await client.api.message("message/one");
  const url = new URL(calls[0].path, base);
  expect(url.pathname).toBe("/api/projects/p%2F1/messages/page");
  expect(Object.fromEntries(url.searchParams)).toEqual({ scope: "member", memberId: "m/1", cursor: "a+/=opaque", limit: "100" });
  expect(calls[1].path).toBe("/api/messages/message%2Fone");
});

test("reviewed strict write conflict is preserved without a weaker retry", async () => {
  await expect(client.api.putSettingsV2({ maxAwakeWorkers: 3 }, 12)).rejects.toMatchObject({ status: 409 });
  expect(calls).toHaveLength(1);
  expect(calls[0].headers.get("if-match")).toBe('"12"');
  expect(calls[0].headers.get("x-iamceo-contract")).toBe("2");
  await client.api.patchMemberV2("m", { modelOverride: "a-model" }, 4);
  await client.api.todoDoneV2("t", true, 6);
  expect(calls.slice(1).map(call => [call.headers.get("if-match"), call.headers.get("x-iamceo-contract")])).toEqual([['"4"', "2"], ['"6"', "2"]]);
});

test("decision answer transmits the version the user reviewed", async () => {
  await client.api.answer("d", { choice: "yes", expectedVersion: "2026-11-09T00:00:00.001Z" });
  expect(calls[0].headers.get("x-iamceo-contract")).toBe("2");
  expect(calls[0].body).toMatchObject({ expectedVersion: "2026-11-09T00:00:00.001Z" });
});

test("a 401 from an old login cannot log out a newer login with the same code", async () => {
  wait401 = true;
  let unauthorized = 0;
  client.setUnauthorizedHandler(() => { unauthorized++; });
  const entered = new Promise<void>(resolve => { captured401 = resolve; });
  const pending = client.api.bootstrap().catch(error => error);
  await entered;
  client.setAccessCode("fixture-private-code");
  release401!();
  expect(await pending).toMatchObject({ status: 401 });
  expect(unauthorized).toBe(0);
});

test("aborted snapshot reads reject without issuing a replacement request", async () => {
  const abort = new AbortController(); abort.abort();
  await expect(client.api.sync("hq", abort.signal)).rejects.toMatchObject({ status: 0 });
  expect(calls).toHaveLength(0);
});

test("auxiliary reads honor cancellation without starting hidden-tab requests", async () => {
  const abort = new AbortController(); abort.abort();
  await expect(Promise.all([
    client.api.activity("m", 20, abort.signal),
    client.api.decision("d", abort.signal),
    client.api.doneDecisions("p", {}, abort.signal),
    client.api.messages("p", {}, abort.signal),
  ])).rejects.toMatchObject({ status: 0 });
  expect(calls).toHaveLength(0);
});


test("an old attachment response cannot invalidate a newer login", async () => {
  wait401 = true;
  let unauthorized = 0;
  client.setUnauthorizedHandler(() => { unauthorized++; });
  const entered = new Promise<void>(resolve => { captured401 = resolve; });
  const pending = client.fetchAttachment({ url: "/files/old" }).catch(error => error);
  await entered;
  client.setAccessCode("fixture-private-code");
  release401!();
  expect(await pending).toMatchObject({ status: 401 });
  expect(unauthorized).toBe(0);
});

test("another tab replacing the stored code fences an old 401", async () => {
  wait401 = true;
  let unauthorized = 0;
  client.setUnauthorizedHandler(() => { unauthorized++; });
  const entered = new Promise<void>(resolve => { captured401 = resolve; });
  const pending = client.api.bootstrap().catch(error => error);
  await entered;
  // A storage event from another document changes the value without executing
  // this document's setAccessCode or incrementing its local generation.
  values.set("iamceo.accessCode", "other-tab-new-code");
  release401!();
  expect(await pending).toMatchObject({ status: 401 });
  expect(unauthorized).toBe(0);
  expect(client.getAccessCode()).toBe("other-tab-new-code");
});
