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

import { legacyStorage } from "./fixtures/legacy-storage.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(version: 33 | 34 = 33) {
  const runtime = createIsolatedRuntime();
  cleanups.push(() => runtime.stop());
  const path = join(runtime.paths.iamceoHome, "iamceo.db");
  const { db, projectId, memberId, at } = legacyStorage(path, runtime.paths.work, version);
  const fileId = "f_legacy", decisionId = "d_legacy";
  const body = "본문 🐈\u0000\r\n".repeat(8000), html = "<main>시안 원문</main>".repeat(8000);
  db.query(`INSERT INTO files (id,project_id,title,body,html,kind,created_at,sort_order)
    VALUES (?,?,'원본',?,?,'artifact',?,1)`).run(fileId, projectId, body, html, at);
  const result = { text: JSON.stringify({ sourceMessageId: "msg_original", files: [{ id: fileId, title: "원본", body, html }] }) };
  const insert = db.query("INSERT INTO agent_operation_receipts VALUES (?,?,?,?,?,?,?)");
  for (let i = 0; i < 8; i++) {
    const request = JSON.stringify({ report_id: "msg_original" });
    insert.run(`op-${i}`, memberId, projectId, "post", request, '{"text":"이 작업의 결과를 확인할 수 없습니다. 같은 작업은 자동 재실행하지 않습니다","isError":true}', "2026-11-17T00:00:00.000Z");
    insert.run(`agent-result:op-${i}`, memberId, projectId, "post", request, JSON.stringify(result), "2026-11-17T00:00:01.000Z");
  }
  db.query(`INSERT INTO decisions (id,project_id,member_id,who,title,status,created_at,updated_at)
    VALUES (?,?,?,'작업자','승인 대기','open',?,?)`).run(decisionId, projectId, memberId, at, at);
  db.close();
  return { runtime, path, body, html, fileId, memberId, result, decisionId };
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
  expect(store.getFile(f.fileId)!.body === f.body).toBe(true);
  expect(store.getFileHtml(f.fileId) === f.html).toBe(true);
  expect(store.agentOperation(f.memberId, "post", "op-0", { report_id: "msg_original" }, () => ({ text: "must not execute" }))).toEqual(f.result);
  expect(store.requireDecision(f.decisionId).status).toBe("open");
  db.close();
  expect(readdirSync(f.runtime.paths.iamceoHome).some(n => n.includes(".bak") || n.includes(".pre-v"))).toBe(false);
  const again = optimizeStorage(f.runtime.paths.iamceoHome, { vacuum: true });
  expect(again.verified).toBe(true);
  expect(again.after.receiptCount).toBe(8);
});

test("corrupt legacy content fails before any schema change and leaves original rows intact", () => {
  const f = fixture();
  const db = new Database(f.path);
  db.query("UPDATE files SET body = ? WHERE id = ?").run(Buffer.from([1,2,3]), f.fileId);
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
  expect(store.agentOperation(f.memberId, "post", "op-0", { report_id: "msg_original" }, () => ({ text: "must not execute" }))).toEqual(f.result);
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

test("offline optimization verifies the v55 card transition and rejects unrelated edits during backfill", () => {
  for (const unexpectedEdit of [false, true]) {
    const runtime = createIsolatedRuntime(), path = join(runtime.paths.iamceoHome, "iamceo.db");
    cleanups.push(() => runtime.stop());
    const { db, projectId, at } = legacyStorage(path, runtime.paths.work, 54);
    const completedAt = "2026-11-18T00:00:00.000Z";
    db.query("INSERT INTO tasks(id,project_id,title,created_at,updated_at) VALUES('tk_w_old',?,'기존 업무',?,?)").run(projectId, at, at);
    db.query("INSERT INTO messages(id,project_id,task_id,at,kind) VALUES('msg_done',?,'tk_w_old',?,'완료')").run(projectId, completedAt);
    const mark = db.query(`INSERT INTO task_stage_marks(project_id,task_id,stage,evidence,who,at)
      VALUES (?,'tk_w_old','done','통과','하네스',?)`).run(projectId, completedAt);
    db.query(`INSERT INTO task_completion_reviews(report_id,task_id,contract_task_id,contract_rev,mark_id,status,completed_at)
      VALUES ('msg_done','tk_w_old','tk_w_old',1,?,'pending',?)`).run(mark.lastInsertRowid, completedAt);
    db.query(`INSERT INTO work(id,project_id,sec,title,sort_order,created_at,updated_at)
      VALUES ('w_old',?,'next','기존 업무',1,?,?)`).run(projectId, at, at);
    if (unexpectedEdit) db.exec(`CREATE TRIGGER change_original AFTER UPDATE OF sec ON work BEGIN
      UPDATE work SET title='바뀐 제목' WHERE id=NEW.id; END`);
    db.close();
    if (unexpectedEdit) {
      expect(() => optimizeStorage(runtime.paths.iamceoHome)).toThrow("논리 데이터");
    } else {
      expect(optimizeStorage(runtime.paths.iamceoHome, { vacuum: true }).verified).toBe(true);
      const check = new Database(path, { readonly: true });
      expect(check.query("SELECT sec,auto_done_from,done_at FROM work WHERE id='w_old'").get())
        .toEqual({ sec: "done", auto_done_from: "next", done_at: completedAt });
      expect(check.query("SELECT board_revision FROM projects WHERE id=?").get(projectId)).toEqual({ board_revision: 1 });
      check.close();
    }
  }
});
