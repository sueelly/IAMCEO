import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { Bus } from "../server/bus.ts";
import { loadConfig } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { Orchestrator, type AgentToolsImpl } from "../server/orchestrator.ts";
import { handleAgentTool, listAgentTools } from "../server/agent-tools.ts";
import { publicHarness } from "../server/harness-redaction.ts";
import { Store } from "../server/store.ts";
import { decodeStoredText } from "../server/stored-text.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(legacy = false) {
  const runtime = createIsolatedRuntime();
  cleanups.push(() => runtime.stop());
  const path = join(runtime.paths.iamceoHome, "test.db");
  let db: Database;
  if (legacy) {
    db = new Database(path, { create: true });
    for (let v = 0; v < 33; v++) db.exec(MIGRATIONS[v]!);
    db.exec("PRAGMA user_version = 33");
  } else db = openDb(path);
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "저장 최적화", cwd: runtime.paths.work });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "작업자", kind: "worker", origin: "manual" });
  cleanups.push(() => { try { db.close(); } catch {} });
  const config = loadConfig({ IAMCEO_HOME: runtime.paths.iamceoHome, IAMCEO_PORT: "0" });
  function orchestrator(tools: AgentToolsImpl = { handleAgentTool, listAgentTools }) {
    const orch = new Orchestrator({ config, store, runners: new Map(), agentTools: tools });
    cleanups.push(() => orch.shutdown());
    return orch;
  }
  return { runtime, path, db, store, project, member, orchestrator };
}

function state(f: ReturnType<typeof fixture>, id: string) {
  return f.db.query<{ state: string; result_json: unknown; result_kind: string }, [string]>("SELECT state,result_json,result_kind FROM agent_operation_receipts WHERE operation_id = ?").get(id)!;
}

test("one durable row transitions reserved to completed; concurrent/replayed calls do not repeat effects", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let effects = 0;
  const orch = f.orchestrator({ listAgentTools: () => [], async handleAgentTool() {
    effects++;
    await gate;
    f.store.createMessage({ projectId: f.project.id, kind: "진행", body: "효과 1회" });
    return { text: "실행 결과" };
  } });
  const id = randomUUID();
  const a = orch.handleAgentOperation(f.member, "custom", { value: 1 }, { operationId: id });
  const b = orch.handleAgentOperation(f.member, "custom", { value: 1 }, { operationId: id });
  expect(state(f, id).state).toBe("reserved");
  release();
  expect(await a).toEqual({ text: "실행 결과" });
  expect(await b).toEqual({ text: "실행 결과" });
  expect(state(f, id).state).toBe("completed");
  expect(f.db.query("SELECT count(*) AS n FROM agent_operation_receipts").get()).toEqual({ n: 1 });
  expect(await orch.handleAgentOperation(f.member, "custom", { value: 1 }, { operationId: id })).toEqual({ text: "실행 결과" });
  expect(effects).toBe(1);
  expect(f.store.listMessages(f.project.id)).toHaveLength(1);
  await expect(orch.handleAgentOperation(f.member, "custom", { value: 2 }, { operationId: id })).rejects.toThrow("operationId");
});

test("interrupted reservations remain fenced after restart; explicit tool errors complete and replay", async () => {
  const f = fixture();
  let effects = 0;
  const first = f.orchestrator({ listAgentTools: () => [], async handleAgentTool() { effects++; throw new Error("interrupted"); } });
  const id = randomUUID();
  await expect(first.handleAgentOperation(f.member, "custom", {}, { operationId: id })).rejects.toThrow("interrupted");
  const second = f.orchestrator({ listAgentTools: () => [], async handleAgentTool() { effects++; return { text: "도구 거절", isError: true }; } });
  expect(await second.handleAgentOperation(f.member, "custom", {}, { operationId: id })).toMatchObject({ isError: true });
  expect(state(f, id).state).toBe("reserved");
  const errorId = randomUUID();
  expect(await second.handleAgentOperation(f.member, "custom", {}, { operationId: errorId })).toEqual({ text: "도구 거절", isError: true });
  expect(state(f, errorId).state).toBe("completed");
  await second.handleAgentOperation(f.member, "custom", {}, { operationId: errorId });
  expect(effects).toBe(2);
});

test("compressed files keep original bodies through get/list/HTML and a new Store", () => {
  const f = fixture();
  const body = "본문 🐈\u0000\r\n".repeat(1200), html = "<main>한글 자료</main>".repeat(1200);
  const file = f.store.createFile({ projectId: f.project.id, title: "원본", body, html, kind: "artifact" });
  expect(f.db.query("SELECT typeof(body) AS body,typeof(html) AS html FROM files WHERE id = ?").get(file.id)).toEqual({ body: "blob", html: "blob" });
  expect(f.store.getFile(file.id)!.body === body).toBe(true);
  expect(f.store.listFiles(f.project.id)[0]!.body === body).toBe(true);
  const next = new Store(f.db, new Bus());
  expect(next.getFileHtml(file.id) === html).toBe(true);
});

test("report lookup receipts retain references, hydrate original material and preserve redaction", async () => {
  const f = fixture();
  const body = "내용 API_TOKEN=canary-secret\n".repeat(300);
  const html = "<main>원본 시안 🐈</main>".repeat(300);
  const file = f.store.createFile({ projectId: f.project.id, title: "자료", body, html, kind: "artifact" });
  const source = f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "완료", title: "결과", fileId: file.id });
  const orch = f.orchestrator();
  const id = randomUUID();
  const args = { report_id: source.id };
  const first = await orch.handleAgentOperation(f.member, "post", args, { operationId: id });
  expect(first.isError).toBeUndefined();
  expect(JSON.parse(first.text).files[0].body === publicHarness(body)).toBe(true);
  const receipt = state(f, id);
  expect(receipt.result_kind).toBe("report-reference-v1");
  const compact = JSON.parse(decodeStoredText(receipt.result_json));
  const compactReport = compact.report;
  expect(compactReport.files[0]).not.toHaveProperty("body");
  expect(compactReport.files[0]).not.toHaveProperty("html");
  expect(await orch.handleAgentOperation(f.member, "post", args, { operationId: id })).toEqual(first);
  expect(f.store.listMessages(f.project.id)).toHaveLength(1);
  f.db.query("DELETE FROM files WHERE id = ?").run(file.id);
  await expect(orch.handleAgentOperation(f.member, "post", args, { operationId: id })).rejects.toThrow();
  expect(f.store.listMessages(f.project.id)).toHaveLength(1);
});

test("legacy paired receipts fold into one row and existing text compresses without a new backup", () => {
  const f = fixture(true);
  const id = randomUUID(), request = JSON.stringify({ content: "자료 내용".repeat(1500) });
  const insert = f.db.query("INSERT INTO agent_operation_receipts VALUES (?,?,?,?,?,?,?)");
  insert.run(id, f.member.id, f.project.id, "file", request, '{"text":"미확인","isError":true}', "2026-11-17T00:00:00.000Z");
  insert.run(`agent-result:${id}`, f.member.id, f.project.id, "file", request, '{"text":"완료 원문"}', "2026-11-17T00:00:01.000Z");
  f.db.close();
  const db = openDb(f.path, { migrationBackup: false });
  cleanups.push(() => db.close());
  expect(db.query("SELECT count(*) AS n FROM agent_operation_receipts").get()).toEqual({ n: 1 });
  expect(db.query("SELECT state,typeof(request_json) AS request_kind FROM agent_operation_receipts").get()).toEqual({ state: "completed", request_kind: "blob" });
  const store = new Store(db, new Bus());
  expect(store.agentOperation<{ text: string }>(f.member.id, "file", id, JSON.parse(request), () => { throw new Error("must not replay"); })).toEqual({ text: "완료 원문" });
  expect(readdirSync(f.runtime.paths.iamceoHome).some(n => n.includes(".pre-v"))).toBe(false);
});

test("legacy report snapshots migrate to references, replay identically after reopen and reject foreign material", async () => {
  const f = fixture(true);
  const file = f.store.createFile({ projectId: f.project.id, title: "자료", body: "본문".repeat(2000), html: "<main>시안</main>".repeat(1000), kind: "artifact" });
  const source = f.store.createMessage({ projectId: f.project.id, memberId: f.member.id, kind: "완료", title: "보고", fileId: file.id });
  const report = { sourceMessageId: source.id, files: [{ id: file.id, title: file.title, summary: file.summary, body: file.body, kind: file.kind, attachments: file.attachments, html: f.store.getFileHtml(file.id) }] };
  const result = { text: JSON.stringify(report) }, args = { report_id: source.id }, id = randomUUID();
  f.db.query("INSERT INTO agent_operation_receipts VALUES (?,?,?,?,?,?,?)").run(id, f.member.id, f.project.id, "post", JSON.stringify(args), JSON.stringify(result), "now");
  f.db.close();
  let db = openDb(f.path, { migrationBackup: false });
  expect(db.query("SELECT result_kind FROM agent_operation_receipts").get()).toEqual({ result_kind: "report-reference-v1" });
  db.close();
  db = openDb(f.path, { migrationBackup: false });
  cleanups.push(() => db.close());
  const store = new Store(db, new Bus());
  expect(store.agentOperation(f.member.id, "post", id, args, () => ({ text: "wrong replay" }))).toEqual(result);
  const other = store.createProject({ name: "다른 범위", cwd: f.runtime.paths.work });
  db.query("UPDATE files SET project_id = ? WHERE id = ?").run(other.id, file.id);
  expect(() => store.agentOperation(f.member.id, "post", id, args, () => ({ text: "must not execute" }))).toThrow();
});

test("legacy interrupted reservation keeps its state and never becomes a completed effect", () => {
  const f = fixture(true), id = randomUUID();
  const pending = { text: "이 작업의 결과를 확인할 수 없습니다. 같은 작업은 자동 재실행하지 않습니다", isError: true };
  f.db.query("INSERT INTO agent_operation_receipts VALUES (?,?,?,?,?,?,?)").run(id, f.member.id, f.project.id, "custom", "{}", JSON.stringify(pending), "now");
  f.db.close();
  const db = openDb(f.path, { migrationBackup: false });
  cleanups.push(() => db.close());
  const store = new Store(db, new Bus());
  expect(store.reserveAgentOperation(f.member.id, "custom", id, {}, pending)).toEqual({ created: false, state: "reserved", result: pending });
});

test("migration preserves mismatched/unpaired receipts and rolls back on a corrupt stored body", () => {
  const f = fixture(true);
  const insert = f.db.query("INSERT INTO agent_operation_receipts VALUES (?,?,?,?,?,?,?)");
  for (const [id, req] of [["pair", "{}"], ["agent-result:pair", '{"different":true}'], ["orphan", "{}"], ["agent-result:missing", "{}"]]) {
    insert.run(id, f.member.id, f.project.id, "custom", req, '{"text":"原文"}', "2026-11-17T00:00:00.000Z");
  }
  f.db.query("INSERT INTO files (id,project_id,title,body,attachments,created_at,sort_order) VALUES ('bad',?,'bad',?,'[]','now',1)").run(f.project.id, Buffer.from([1,2,3]));
  f.db.close();
  expect(() => openDb(f.path, { migrationBackup: false })).toThrow();
  const old = new Database(f.path);
  expect(old.query("PRAGMA user_version").get()).toEqual({ user_version: 33 });
  expect(old.query("SELECT count(*) AS n FROM agent_operation_receipts").get()).toEqual({ n: 4 });
  old.query("UPDATE files SET body = '원문' WHERE id = 'bad'").run();
  old.close();
  const db = openDb(f.path, { migrationBackup: false });
  cleanups.push(() => db.close());
  expect(db.query("SELECT count(*) AS n FROM agent_operation_receipts").get()).toEqual({ n: 4 });
});
