import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { DevMemory } from "../server/integrations/dev-memory.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
type Body = { project_id: string; experience: { event_id: string } };
const acknowledged = (body: Body) => Response.json({ ...body.experience, id: `exp-${body.experience.event_id}`, project_id: body.project_id }, { status: 201 });
function fixture(reply: (body: Body, init: RequestInit) => Promise<Response> = async body => acknowledged(body)) {
  const home = mkdtempSync("/private/tmp/iamceo-memory-transport-"), keyFile = join(home, "key");
  writeFileSync(keyFile, "isolated-memory-transport-key", { mode: 0o600 });
  const db = openDb(":memory:"), store = new Store(db, new Bus());
  const one = store.createProject({ name: "첫 프로젝트", cwd: home }), two = store.createProject({ name: "두 번째 프로젝트", cwd: home });
  const enabled = new Set([one.id, two.id]), calls: Body[] = [];
  const memory = new DevMemory({ baseUrl: "http://127.0.0.1:1", keyFile, projects: [] }, async (_url, init) => {
    if (!init.body) return Response.json({ ok: true });
    const body = JSON.parse(String(init.body)) as Body; calls.push(body); return reply(body, init);
  });
  memory.setProjectGate(id => enabled.has(id));
  let closed = false;
  const closeDb = () => { db.close(); closed = true; };
  cleanups.push(async () => { memory.stop(); await memory.drain?.(); if (!closed) closeDb(); /* Preserve the isolated fixture directory for review. */ });
  function enqueue(id: string, projectId = one.id, body?: string) {
    store.enqueueMemoryUpload({ eventId: id, projectId, refType: "archive_message", refId: id,
      body: body ?? JSON.stringify({ event_id: id, kind: "outcome", summary: id, content: `원문 ${id}`, source: { task_id: "task-original", service: "iamceo" } }) });
  }
  return { db, store, one, two, enabled, calls, memory, enqueue, closeDb };
}

test("disabled oldest rows cannot starve another project's eligible uploads", async () => {
  const f = fixture(); f.enabled.delete(f.one.id);
  for (let i = 0; i < 25; i++) f.enqueue(`disabled-${i}`);
  f.enqueue("enabled-newer", f.two.id);
  await f.memory.flush(f.store);
  expect(f.store.getMemoryUpload("enabled-newer")).toMatchObject({ status: "sent", attempts: 1 });
  expect(f.store.listMemoryUploads(f.one.id).every(row => row.status === "pending" && row.attempts === 0)).toBe(true);
  expect(f.calls.map(c => c.experience.event_id)).toEqual(["enabled-newer"]);
});

test("Store filters eligible projects before applying the requested queue limit", () => {
  const f = fixture(); f.enqueue("first-disabled"); f.enqueue("second-enabled", f.two.id);
  expect(f.store.dueMemoryUploads("2999-01-01T00:00:00.000Z", 1, [f.two.id]).map(row => row.eventId)).toEqual(["second-enabled"]);
  expect(f.store.dueMemoryUploads("2999-01-01T00:00:00.000Z", 1, [])).toEqual([]);
  expect(f.store.dueMemoryUploads("2999-01-01T00:00:00.000Z", 1).map(row => row.eventId)).toEqual(["first-disabled"]);
});

test("a large backfill drains in bounded groups instead of leaving only twenty uploads per minute", async () => {
  const f = fixture();
  for (let i = 0; i < 130; i++) f.enqueue(`bulk-${i}`);
  await f.memory.flush(f.store);
  expect(f.store.listMemoryUploads().filter(row => row.status === "sent")).toHaveLength(100);
  expect(f.store.listMemoryUploads().filter(row => row.status === "pending")).toHaveLength(30);
  await f.memory.flush(f.store);
  expect(f.store.listMemoryUploads().every(row => row.status === "sent" && row.attempts === 1)).toBe(true);
});

test("concurrent wakeups share one flight and include newly queued work without promise chains", async () => {
  const started = deferred(), release = deferred();
  const f = fixture(async body => { if (body.experience.event_id === "first") { started.resolve(); await release.promise; } return acknowledged(body); });
  f.enqueue("first"); const first = f.memory.flush(f.store); await started.promise;
  f.enqueue("second"); const flights = Array.from({ length: 200 }, () => f.memory.flush(f.store));
  try { expect(flights.every(flight => flight === first)).toBe(true); }
  finally { release.resolve(); await Promise.all([first, ...flights]); }
  expect(f.calls.map(c => c.experience.event_id)).toEqual(["first", "second"]);
  expect(f.store.listMemoryUploads().every(row => row.status === "sent")).toBe(true);
});

test("disabling a project during a request keeps its receipt but suspends its next unsent row", async () => {
  const started = deferred(), release = deferred();
  const f = fixture(async body => { if (body.experience.event_id === "in-flight") { started.resolve(); await release.promise; } return acknowledged(body); });
  f.enqueue("in-flight"); f.enqueue("not-started"); f.enqueue("other-project", f.two.id);
  const flight = f.memory.flush(f.store); await started.promise;
  f.enabled.delete(f.one.id); release.resolve(); await flight;
  expect(f.store.getMemoryUpload("in-flight")).toMatchObject({ status: "sent", attempts: 1 });
  expect(f.store.getMemoryUpload("not-started")).toMatchObject({ status: "pending", attempts: 0 });
  expect(f.store.getMemoryUpload("other-project")?.status).toBe("sent");
  expect(f.calls.map(c => c.experience.event_id)).toEqual(["in-flight", "other-project"]);
});

test("stop cancels the transport and fences late acknowledgments before a database is closed", async () => {
  const started = deferred(), release = deferred(); let requestSignal: AbortSignal | null | undefined;
  const f = fixture(async (body, init) => { requestSignal = init.signal; started.resolve(); await release.promise; return acknowledged(body); });
  f.enqueue("before-stop"); f.enqueue("after-stop");
  const flight = f.memory.flush(f.store); await started.promise;
  try {
    f.memory.stop();
    expect(requestSignal?.aborted).toBe(true);
    expect(f.store.getMemoryUpload("before-stop")).toMatchObject({ status: "pending", attempts: 1 });
    let drained = false;
    void f.memory.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    f.closeDb();
  } finally { release.resolve(); }
  await expect(flight).resolves.toBeUndefined();
  await expect(f.memory.drain()).resolves.toBeUndefined();
  await expect(f.memory.flush(f.store)).resolves.toBeUndefined();
  expect(f.calls.map(c => c.experience.event_id)).toEqual(["before-stop"]);
});

test("rate limits and remote request timeouts remain retryable instead of losing archived input", async () => {
  const f = fixture(async body => Response.json({ error: "try_later" }, { status: body.experience.event_id === "limited" ? 429 : 408 }));
  f.enqueue("limited"); f.enqueue("timeout");
  await f.memory.flush(f.store);
  expect(f.store.listMemoryUploads().every(row => row.status === "pending" && row.attempts === 1 && row.nextAt > row.createdAt)).toBe(true);
});

test("fixing a rotated key resumes unauthorized archive uploads without changing their event or attempts", async () => {
  let denied = true;
  const f = fixture(async body => denied ? Response.json({ error: "unauthorized" }, { status: body.experience.event_id === "key" ? 401 : 403 }) : acknowledged(body));
  f.enqueue("key"); f.enqueue("host");
  await f.memory.flush(f.store);
  expect(f.store.listMemoryUploads().every(row => row.status === "pending" && row.attempts === 1)).toBe(true);
  denied = false;
  for (const row of f.store.listMemoryUploads()) f.store.settleMemoryUpload(row.eventId, { status: "pending", attempts: row.attempts, nextAt: "2000-01-01T00:00:00.000Z" });
  await f.memory.flush(f.store);
  expect(f.store.listMemoryUploads().every(row => row.status === "sent" && row.attempts === 2)).toBe(true);
  expect(f.calls[0]).toEqual(f.calls[2]);
});

test("a malformed old payload and a permanent rejection do not stop later valid records", async () => {
  const f = fixture(async body => body.experience.event_id === "rejected" ? Response.json({ error: "invalid_memory_request" }, { status: 400 }) : acknowledged(body));
  f.enqueue("broken-json", f.one.id, "not-json"); f.enqueue("broken-shape", f.one.id, "null"); f.enqueue("rejected"); f.enqueue("valid");
  await f.memory.flush(f.store);
  expect(f.store.getMemoryUpload("broken-json")).toMatchObject({ status: "rejected", attempts: 0 });
  expect(f.store.getMemoryUpload("broken-shape")).toMatchObject({ status: "rejected", attempts: 0 });
  expect(f.store.getMemoryUpload("rejected")).toMatchObject({ status: "rejected", attempts: 1 });
  expect(f.store.getMemoryUpload("valid")).toMatchObject({ status: "sent", attempts: 1 });
});

test("transient failures keep cumulative attempts and retry the same event after the sixth failure", async () => {
  let down = true;
  const f = fixture(async body => down && body.experience.event_id === "retry" ? Response.json({ error: "unavailable" }, { status: 503 }) : acknowledged(body));
  f.enqueue("retry"); f.enqueue("healthy");
  f.store.settleMemoryUpload("retry", { status: "pending", attempts: 6, nextAt: "2000-01-01T00:00:00.000Z" });
  await f.memory.flush(f.store);
  expect(f.store.getMemoryUpload("retry")).toMatchObject({ status: "pending", attempts: 7 });
  expect(f.store.getMemoryUpload("healthy")?.status).toBe("sent");
  down = false;
  f.store.settleMemoryUpload("retry", { status: "pending", attempts: 7, nextAt: "2000-01-01T00:00:00.000Z" });
  await f.memory.flush(f.store);
  expect(f.store.getMemoryUpload("retry")).toMatchObject({ status: "sent", attempts: 8 });
  expect(f.calls.filter(c => c.experience.event_id === "retry")[0]).toEqual(f.calls.at(-1)!);
});

test("empty or mismatched acknowledgments never mark the original event as stored", async () => {
  const f = fixture(async body => Response.json(body.experience.event_id === "empty" ? {} :
    { id: "exp-different", project_id: body.project_id, event_id: "another-event" }, { status: 201 }));
  f.enqueue("empty"); f.enqueue("mismatch"); await f.memory.flush(f.store);
  expect(f.store.listMemoryUploads().every(row => row.status === "pending" && row.remoteId === null && row.attempts === 1)).toBe(true);
});
