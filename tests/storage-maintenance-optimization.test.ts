import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { Bus } from "../server/bus.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { acquireHomeOwner } from "../server/home-owner.ts";
import { inspectStorage, optimizeStorage } from "../scripts/optimize-storage.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(version: 33 | 34 = 33) {
  const runtime = createIsolatedRuntime();
  cleanups.push(() => runtime.stop());
  const path = join(runtime.paths.iamceoHome, "iamceo.db"), db = new Database(path, { create: true });
  for (let v = 0; v < version; v++) db.exec(MIGRATIONS[v]!);
  db.exec(`PRAGMA user_version = ${version}`);
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "기존 자료", cwd: runtime.paths.work });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "작업자", kind: "worker", origin: "manual" });
  const body = "본문 🐈\u0000\r\n".repeat(8000), html = "<main>시안 원문</main>".repeat(8000);
  const file = store.createFile({ projectId: project.id, title: "원본", body: "legacy", kind: "artifact" });
  db.query("UPDATE files SET body = ?, html = ? WHERE id = ?").run(body, html, file.id);
  const result = { text: JSON.stringify({ sourceMessageId: "msg_original", files: [{ id: file.id, title: "원본", body, html }] }) };
  const insert = db.query("INSERT INTO agent_operation_receipts VALUES (?,?,?,?,?,?,?)");
  for (let i = 0; i < 8; i++) {
    const request = JSON.stringify({ report_id: "msg_original" });
    insert.run(`op-${i}`, member.id, project.id, "post", request, '{"text":"이 작업의 결과를 확인할 수 없습니다. 같은 작업은 자동 재실행하지 않습니다","isError":true}', "2026-11-17T00:00:00.000Z");
    insert.run(`agent-result:op-${i}`, member.id, project.id, "post", request, JSON.stringify(result), "2026-11-17T00:00:01.000Z");
  }
  const decision = store.createDecision({ projectId: project.id, memberId: member.id, who: member.name, title: "승인 대기" });
  db.close();
  return { runtime, path, body, html, file, project, member, result, decision };
}

test("inspection reports allocation and counts without migrating or creating backups", () => {
  const f = fixture(), before = statSync(f.path).size;
  const result = inspectStorage(f.runtime.paths.iamceoHome);
  expect(result.schemaVersion).toBe(33);
  expect(result.fileBytes).toBe(before);
  expect(result.receiptCount).toBe(16);
  expect(readdirSync(f.runtime.paths.iamceoHome).some(n => n.includes(".bak") || n.includes(".pre-v"))).toBe(false);
  const db = new Database(f.path, { readonly: true });
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 33 });
  db.close();
});

test("offline apply refuses an active home owner without touching its schema or data", () => {
  const f = fixture(), owner = acquireHomeOwner(f.runtime.paths.iamceoHome);
  try { expect(() => optimizeStorage(f.runtime.paths.iamceoHome, { vacuum: true })).toThrow("사용 중"); }
  finally { owner.release(); }
  expect(inspectStorage(f.runtime.paths.iamceoHome).schemaVersion).toBe(33);
});

test("verified no-backup migration and compaction reduce actual allocation while preserving text, replay and approvals", () => {
  const f = fixture();
  const result = optimizeStorage(f.runtime.paths.iamceoHome, { vacuum: true });
  console.info("synthetic storage optimization:", JSON.stringify(result));
  expect(result.verified).toBe(true);
  expect(result.before.receiptCount).toBe(16);
  expect(result.after.receiptCount).toBe(8);
  expect(result.after.fileBytes).toBeLessThan(result.before.fileBytes / 2);
  const db = openDb(f.path, { migrationBackup: false });
  const store = new Store(db, new Bus());
  expect(store.getFile(f.file.id)!.body === f.body).toBe(true);
  expect(store.getFileHtml(f.file.id) === f.html).toBe(true);
  expect(store.agentOperation(f.member.id, "post", "op-0", { report_id: "msg_original" }, () => ({ text: "must not execute" }))).toEqual(f.result);
  expect(store.requireDecision(f.decision.id).status).toBe("open");
  db.close();
  expect(readdirSync(f.runtime.paths.iamceoHome).some(n => n.includes(".bak") || n.includes(".pre-v"))).toBe(false);
  const again = optimizeStorage(f.runtime.paths.iamceoHome, { vacuum: true });
  expect(again.verified).toBe(true);
  expect(again.after.receiptCount).toBe(8);
});

test("corrupt legacy content fails before any schema change and leaves original rows intact", () => {
  const f = fixture();
  const db = new Database(f.path);
  db.query("UPDATE files SET body = ? WHERE id = ?").run(Buffer.from([1,2,3]), f.file.id);
  db.close();
  expect(() => optimizeStorage(f.runtime.paths.iamceoHome, { vacuum: true })).toThrow();
  expect(inspectStorage(f.runtime.paths.iamceoHome).schemaVersion).toBe(33);
  expect(inspectStorage(f.runtime.paths.iamceoHome).receiptCount).toBe(16);
});

test("pagination v34 upgrades through offline apply, preserving its indexes and normalized replay", () => {
  const f = fixture(34);
  const result = optimizeStorage(f.runtime.paths.iamceoHome, { vacuum: true });
  expect(result.before.schemaVersion).toBe(34);
  expect(result.after.schemaVersion).toBe(MIGRATIONS.length);
  expect(result.after.receiptCount).toBe(8);
  const db = openDb(f.path, { migrationBackup: false });
  const store = new Store(db, new Bus());
  expect(db.query("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('files_page_project','files_page_task','messages_task_page')").get()).toEqual({ n: 3 });
  expect(store.agentOperation(f.member.id, "post", "op-0", { report_id: "msg_original" }, () => ({ text: "must not execute" }))).toEqual(f.result);
  db.close();
});

test("a colliding schema version without receipt columns is refused before changing database bytes", () => {
  const f = fixture(34), old = new Database(f.path);
  old.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  old.close();
  const bytes = readFileSync(f.path);
  const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../scripts/optimize-storage.ts"), "--home", f.runtime.paths.iamceoHome, "--apply", "--vacuum"],
    { cwd: f.runtime.paths.work, env: f.runtime.childEnv(), stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1);
  expect(child.stderr.toString()).toContain("스키마");
  expect(readFileSync(f.path).equals(bytes)).toBe(true);
});
