import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../server/bus.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { optimizeStorage } from "../scripts/optimize-storage.ts";
import { TaskContinuationCoordinator } from "../server/task-continuation.ts";
import { reconcileNextCompletionFamily } from "../server/task-completion.ts";
import { Store } from "../server/store.ts";
import { DEFAULT_PUSH_PREFERENCES, PUSH_REPORT_GROUP_WINDOW_MS } from "../shared/push.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import type { IsolatedRuntime } from "./fixtures/isolated-runtime.ts";

const at = "2026-11-07T00:00:00.123Z";
const afterWindow = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN context_window INTEGER")) + 1;
const beforeLastActive = MIGRATIONS.findIndex(sql => sql.includes("ADD COLUMN last_active_at TEXT"));
const runtimes: IsolatedRuntime[] = [];
const connections: Database[] = [];

afterEach(async () => {
  for (const db of connections.splice(0).reverse()) db.close();
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

function fixture(name = "iamceo.db") {
  const runtime = createIsolatedRuntime();
  runtimes.push(runtime);
  return { runtime, path: join(runtime.paths.iamceoHome, name) };
}

function track(db: Database): Database {
  connections.push(db);
  return db;
}

function version(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
}

describe("last active timestamp migration", () => {
  test("backfills MAX of work kinds once for 50,000 rows, keeps nulls/updatedAt, and reopens idempotently", () => {
    const { path, runtime } = fixture();
    expect(beforeLastActive).toBeGreaterThan(0);
    const old = historicalDb(path, beforeLastActive);
    old.query(`INSERT INTO members (id,project_id,handle,name,kind,origin,status,cwd,token,created_at,updated_at)
      VALUES ('empty','p','empty','기록 없음','worker','runner','idle','/fixture','empty-token',?,?),
      ('noise','p','noise','시스템 기록만','worker','runner','idle','/fixture','noise-token',?,?)`).run(at, at, at, at);
    const insert = old.query("INSERT INTO activity (member_id,at,kind,text) VALUES (?,?,?,'기존 기록')");
    const expected = "2026-11-07T01:00:00.000Z";
    old.transaction(() => {
      const kinds = ["turn_start", "turn_end", "tool", "tool_result"];
      for (let i = 0; i < 50_000; i++) insert.run("m", at, kinds[i % kinds.length]);
      // 가장 늦게 삽입된 줄이 아니라 가장 늦은 at을 고른다.
      insert.run("m", expected, "tool_result");
      insert.run("m", at, "turn_end");
      for (const kind of ["system", "error", "text", "compact"]) {
        insert.run("m", "2099-01-01T00:00:00.000Z", kind);
        insert.run("noise", "2099-01-01T00:00:00.000Z", kind);
      }
    })();
    old.close();
    const started = performance.now();
    const db = openDb(path);
    const elapsed = performance.now() - started;
    console.info(`lastActiveAt migration: 50,010 activity rows including pre-migration backup in ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(5000);
    const rows = db.query("SELECT id,last_active_at,updated_at FROM members ORDER BY id").all();
    expect(rows).toEqual([
      { id: "empty", last_active_at: null, updated_at: at },
      { id: "m", last_active_at: expected, updated_at: at },
      { id: "noise", last_active_at: null, updated_at: at },
    ]);
    expect(version(db)).toBe(MIGRATIONS.length);
    db.close();
    const again = track(openDb(path));
    expect(again.query("SELECT id,last_active_at,updated_at FROM members ORDER BY id").all()).toEqual(rows);
    expect(backups(runtime)).toHaveLength(1);
  });

  test("failed backfill rolls back both column and version; opening again retries successfully", () => {
    const { path } = fixture();
    const old = historicalDb(path, beforeLastActive);
    old.query("INSERT INTO activity (member_id,at,kind,text) VALUES ('m',?,'tool','작업')").run(at);
    old.exec("CREATE TRIGGER reject_backfill BEFORE UPDATE ON members BEGIN SELECT RAISE(ABORT, 'reject backfill'); END");
    old.close();
    expect(() => openDb(path)).toThrow("reject backfill");
    const unchanged = new Database(path);
    expect(version(unchanged)).toBe(beforeLastActive);
    expect(columns(unchanged, "members")).not.toContain("last_active_at");
    expect(unchanged.query("SELECT updated_at FROM members WHERE id='m'").get()).toEqual({ updated_at: at });
    unchanged.exec("DROP TRIGGER reject_backfill");
    unchanged.close();
    const retried = track(openDb(path));
    expect(version(retried)).toBe(MIGRATIONS.length);
    expect(retried.query("SELECT last_active_at FROM members WHERE id='m'").get()).toEqual({ last_active_at: at });
  });
});

function columns(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function backups(runtime: IsolatedRuntime): string[] {
  return readdirSync(runtime.paths.iamceoHome).filter((name) => name.includes(".pre-v"));
}

// The fixture begins in the original schema; every historical data migration really runs.
function historicalDb(path: string, target: number): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  for (let v = 0; v < target; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      if (v === 0) seed(db);
    })();
  }
  return db;
}

test("explicit execution contract migration preserves old revisions and leaves unspecified terms unknown", () => {
  const before = MIGRATIONS.findIndex(sql => sql.includes("ALTER TABLE task_contracts ADD COLUMN inputs"));
  expect(before).toBeGreaterThan(0);
  const { path } = fixture("legacy-contracts.db"), old = historicalDb(path, before);
  const store = new Store(old, new Bus());
  const task = store.ensureSourceTask({ projectId: "p", sourceRef: "legacy-contract", title: "옛 계약", origin: "owner" }).task;
  old.query(`INSERT INTO task_contracts (task_id,rev,kind,goal,acceptance,scope,forbidden,evidence,checks,author,author_kind,source_message_id,at)
    VALUES (?,1,'other','원문 목표','["원래 합격 기준"]','원래 범위','["금지 원문"]','[]','[]','직원','worker','msg_original',?)`).run(task.id, at);
  old.close();
  const migrated = track(openDb(path)), current = new Store(migrated, new Bus());
  expect(current.getTaskContract(task.id)).toMatchObject({ rev: 1, goal: "원문 목표", acceptance: ["원래 합격 기준"], scope: "원래 범위", forbidden: ["금지 원문"], authorKind: "worker", sourceMessageId: "msg_original", at,
    inputs: null, outputs: null, constraints: null, exclusions: null, confirmedAt: null });
  expect(current.listTaskContracts(task.id)).toHaveLength(1);
});

for (const previous of [48, 49]) test(`existing v${previous} completion evidence is queued once and survives reopening`, () => {
  const { path } = fixture("completion-changes.db");
  const old = historicalDb(path, previous);
  const store = new Store(old, new Bus());
  const target = store.ensureSourceTask({ projectId: "p", sourceRef: "existing-report", title: "기존 완료 보고", origin: "owner" }).task;
  old.query("INSERT INTO report_harness(message_id, task_id, member_id, contract_task_id, contract_rev, at) VALUES(?,?,?,?,1,?)")
    .run("report", target.id, "m", target.id, at);
  if (previous === 49) old.exec("DELETE FROM completion_changes");
  old.close();
  const migrated = openDb(path);
  expect(migrated.query("SELECT task_id FROM completion_changes").all()).toEqual([{ task_id: target.id }]);
  migrated.close();
  const reopened = openDb(path), next = new Store(reopened, new Bus());
  try {
    expect(reconcileNextCompletionFamily(next)).toBe(true);
    expect(reconcileNextCompletionFamily(next)).toBe(false);
    expect(reopened.query("SELECT COUNT(*) AS n FROM task_completion_reviews").get()).toEqual({ n: 0 });
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { reopened.close(); }
  const final = track(openDb(path));
  expect(final.query("SELECT task_id FROM completion_changes").all()).toEqual([]);
});

test("deployed v38 continuation state survives the additive workflow receipt migration", () => {
  expect(MIGRATIONS[37]).toContain("CREATE TABLE task_continuations");
  const {path}=fixture("deployed-v38.db"),old=historicalDb(path,38),store=new Store(old,new Bus());
  const task=store.ensureSourceTask({projectId:"p",sourceRef:"migration-continue",title:"멈춘 업무",origin:"owner"}).task;
  old.query("INSERT INTO task_continuations(task_id,project_id,pause_token,pause_reason,updated_at) VALUES(?,?,?,?,?)").run(task.id,"p","keep-stop","중단 보존",at);
  const before=old.query("SELECT id,scope_seq FROM deliveries ORDER BY id").all();old.close();
  const migrated=track(openDb(path));expect(version(migrated)).toBe(MIGRATIONS.length);
  expect(migrated.query("SELECT pause_token FROM task_continuations WHERE task_id=?").get(task.id)).toEqual({pause_token:"keep-stop"});
  expect(migrated.query("SELECT id,scope_seq FROM deliveries ORDER BY id").all()).toEqual(before);
  expect(migrated.query("SELECT name FROM sqlite_master WHERE name='workflow_assignment_receipts'").get()).not.toBeNull();
  expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("deployed v41 memory queues, execution caps and conversations survive archive migration", () => {
  const { path } = fixture("deployed-v41.db"), old = historicalDb(path, 41), store = new Store(old, new Bus());
  store.patchSettings({ maxConcurrentTurns: 24 });
  old.query("UPDATE projects SET max_concurrent_turns=7 WHERE id='p'").run();
  store.enqueueMemoryUpload({ eventId: "keep-sent", projectId: "p", refType: "decision", refId: "original", body: "{}" });
  store.settleMemoryUpload("keep-sent", { status: "sent", attempts: 2, remoteId: "exp-original" });
  store.enqueueMemoryUpload({ eventId: "keep-rejected", projectId: "p", refType: "decision", refId: "failed", body: "{}" });
  store.settleMemoryUpload("keep-rejected", { status: "rejected", attempts: 6, lastError: "HTTP 502" });
  const queue = old.query("SELECT * FROM memory_outbox ORDER BY event_id").all();
  const deliveries = old.query("SELECT * FROM deliveries ORDER BY id").all();
  const members = old.query("SELECT * FROM members ORDER BY id").all();
  const settings = old.query("SELECT * FROM settings").all();
  old.close();
  const migrated = track(openDb(path));
  expect(version(migrated)).toBe(MIGRATIONS.length);
  expect(migrated.query("SELECT * FROM memory_outbox ORDER BY event_id").all()).toEqual(queue);
  expect(migrated.query("SELECT * FROM deliveries ORDER BY id").all()).toEqual(deliveries);
  expect(migrated.query("SELECT * FROM members ORDER BY id").all()).toEqual(members.map((member: any) => ({ ...member, codex_speed: "standard", final_reviewer: 0, parallel_preference: 1, standby_reviewer: 0 })));
  expect(migrated.query("SELECT * FROM settings").all()).toEqual(settings);
  expect(migrated.query("SELECT max_concurrent_turns FROM projects WHERE id='p'").get()).toEqual({ max_concurrent_turns: 7 });
  expect(migrated.query("SELECT * FROM memory_archive_sources").all()).toEqual([]);
  expect(migrated.query("SELECT * FROM memory_feedback_exposures").all()).toEqual([]);
  expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("deployed v39 workflow receipts and queued work survive the failure-state migration", () => {
  expect(MIGRATIONS[38]).toContain("CREATE TABLE workflow_assignment_receipts");
  const { path } = fixture("deployed-v39.db"), old = historicalDb(path, 39);
  old.query("INSERT INTO workflow_assignment_receipts VALUES (?,?,?,?,?,?,?)").run("keep-operation", "p", "task", "m", "delivery", '{"preserve":true}', at);
  const before = old.query("SELECT id, status, text FROM deliveries ORDER BY id").all();
  old.close();
  const migrated = track(openDb(path));
  expect(version(migrated)).toBe(MIGRATIONS.length);
  expect(migrated.query("SELECT request_json FROM workflow_assignment_receipts WHERE operation_id = ?").get("keep-operation")).toEqual({ request_json: '{"preserve":true}' });
  expect(migrated.query("SELECT id, status, text FROM deliveries ORDER BY id").all()).toEqual(before);
  expect(columns(migrated, "members")).toContain("execution_issue_json");
  expect(migrated.query("SELECT execution_issue_json FROM members WHERE id = 'm'").get()).toEqual({ execution_issue_json: null });
  expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("v39의 업무 배정 영수증을 보존하며 실행 상한과 반복 실패 결재를 추가한다", () => {
  expect(MIGRATIONS[38]).toContain("CREATE TABLE workflow_assignment_receipts");
  const { path } = fixture("deployed-v39.db"), old = historicalDb(path, 39);
  old.query(`INSERT INTO workflow_assignment_receipts(operation_id,project_id,task_id,member_id,delivery_id,request_json,created_at)
    VALUES ('reviewed-assignment','p','original-task','m','d','{}',?)`).run(at);
  const receipts = old.query("SELECT * FROM workflow_assignment_receipts").all();
  old.close();
  const migrated = track(openDb(path));
  expect(version(migrated)).toBe(MIGRATIONS.length);
  expect(migrated.query("SELECT * FROM workflow_assignment_receipts").all()).toEqual(receipts);
  expect(migrated.query("SELECT max_concurrent_turns FROM projects WHERE id='p'").get()).toEqual({ max_concurrent_turns: null });
  expect(migrated.query("SELECT * FROM task_failure_escalations").all()).toEqual([]);
  expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

function seed(db: Database): void {
  db.query(`INSERT INTO projects
    (id,name,cwd,backend,permission_mode,runner_enabled,created_at,updated_at)
    VALUES ('p','기존 프로젝트','/fixture','headless','default',1,?,?)`).run(at, at);
  db.query(`INSERT INTO members
    (id,project_id,handle,name,kind,origin,cli,status,cwd,session_id,pane_id,token,context_pct,created_at,updated_at)
    VALUES ('m','p','worker','기존 직원','worker','runner','codex','idle','/fixture','native-old','terminal-old','test-only',42,?,?)`).run(at, at);
  db.query(`INSERT INTO messages (id,project_id,at,member_id,kind,body,delivery)
    VALUES ('msg_한글','p',?,'m','완료','원본 보고','delivered')`).run(at);
  db.query(`INSERT INTO deliveries (id,project_id,member_id,kind,text,status,created_at)
    VALUES ('d','p','m','message','원본 입력','delivered',?)`).run(at);
  db.query(`INSERT INTO decisions (id,project_id,member_id,who,title,status,created_at)
    VALUES ('decision','p','m','기존 직원','기존 질문','open',?)`).run(at);
  db.query(`INSERT INTO todos (id,project_id,title,created_at) VALUES ('todo','p','기존 업무',?)`).run(at);
  db.query(`INSERT INTO work (id,project_id,sec,title,sort_order,created_at,updated_at)
    VALUES ('work','p','doing','진행 중 업무',0,?,?)`).run(at, at);
  db.query(`INSERT INTO files (id,project_id,title,body,created_at,sort_order)
    VALUES ('file','p','자료','자료 본문',?,0)`).run(at);
  db.query(`INSERT INTO attachments (id,name,mime,size,path,created_at)
    VALUES ('attachment','fixture.txt','text/plain',3,'/fixture/attachment',?)`).run(at);
  db.exec(`INSERT INTO settings (key,value) VALUES ('permissionMode','"default"');`);
}

function insertDevice(db: Database, id: string, token: string | null = null, environment = "sandbox"): void {
  db.query(`INSERT INTO push_devices
    (id,label,platform,bundle_id,environment,token,authorization,state,registered_at,last_seen_at,expires_at)
    VALUES (?,?,'ios','com.yehsung.iamceo',?,?,'authorized','active',?,?,?)`).run(id, id, environment, token, at, at, "2026-12-07T00:00:00.123Z");
}

function leaveCommittedWal(runtime: IsolatedRuntime, path: string, schemaVersion: number): void {
  // Only this fixture's SQLite subprocess dies. It never imports config, binds a port, or starts a provider.
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv.at(-1), { create: true });
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE crash_probe (value TEXT); INSERT INTO crash_probe VALUES ('wal-only'); PRAGMA user_version=${schemaVersion};");
    process.kill(process.pid, "SIGKILL");
  `, path], { cwd: runtime.paths.work, env: runtime.childEnv() });
  expect(child.signalCode).toBe("SIGKILL");
  expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
}

describe("append-only migrations", () => {
  test("creation goal migration leaves existing projects null instead of copying mutable now", () => {
    const { path } = fixture();
    const old = historicalDb(path, MIGRATIONS.findIndex(sql => sql.includes("ADD COLUMN creation_goal TEXT")));
    old.query("UPDATE projects SET now='나중에 바뀐 상황' WHERE id='p'").run();
    expect(columns(old, "projects")).not.toContain("creation_goal");
    old.close();
    const db = track(openDb(path));
    const store = new Store(db, new Bus());
    expect(store.requireProject("p")).toMatchObject({ now: "나중에 바뀐 상황", creationGoal: null, createdAt: at });
    const project = store.createProject({ name: "새 목표", cwd: "/fixture", creationGoal: "대표의 원래 목표" });
    store.patchProject(project.id, { now: "바뀐 진행 상황" });
    expect(store.requireProject(project.id).creationGoal).toBe("대표의 원래 목표");
    expect(version(db)).toBe(MIGRATIONS.length);
  });
  test("fresh memory DB has all persistence boundaries, indexes and connection protections", () => {
    const db = track(openDb(":memory:"));
    expect(afterWindow).toBeGreaterThan(0);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name);
    for (const name of [
      "delivery_recovery", "delivery_dispatches", "delivery_dispatch_items", "delivery_recovery_operations",
      "member_context_state", "lifecycle_journal", "execution_journal", "terminal_leases", "operation_receipts",
      "agent_operation_receipts", "domain_revisions", "report_references", "manual_inbox_batches", "manual_inbox_items",
      "push_meta", "push_devices", "push_events", "push_episodes", "push_deliveries", "push_report_groups",
      "push_report_group_reports", "push_report_group_recipients",
    ]) expect(tables).toContain(name);
    expect(columns(db, "members").filter((name) => name === "context_window")).toHaveLength(1);
    expect(columns(db, "members").filter((name) => name === "context_window_source")).toHaveLength(1);
    expect(columns(db, "members")).toContain("session_generation");
    expect(columns(db, "members")).toContain("config_revision");
    expect(columns(db, "deliveries")).toContain("next_attempt_at");
    expect(columns(db, "projects")).toContain("board_reviewed_revision");
    expect(db.query("SELECT * FROM domain_revisions").all()).toEqual([{ domain: "settings", revision: 0 }]);
    // No invented execution, compaction, server identity, or historical push on migration.
    for (const table of ["execution_journal", "lifecycle_journal", "member_context_state", "push_meta", "push_events", "push_episodes", "push_report_groups"])
      expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    for (const index of ["messages_project_page", "messages_member_page", "messages_target_page"]) {
      const keys = db.query<{ name: string; coll: string; key: number }, []>(`PRAGMA index_xinfo(${index})`).all().filter((row) => row.key);
      expect(keys.slice(-2).map((row) => [row.name, row.coll])).toEqual([["at", "BINARY"], ["id", "BINARY"]]);
    }
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='messages_project'").get()).not.toBeNull();
  });

  test("every historical prefix upgrades, retains domain rows and reopens without another backup", () => {
    for (let prefix = 0; prefix <= MIGRATIONS.length; prefix++) {
      const { runtime, path } = fixture(`prefix-${prefix}.db`);
      historicalDb(path, prefix).close();
      const db = openDb(path);
      try {
        expect(version(db)).toBe(MIGRATIONS.length);
        expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        if (prefix > 0) {
          expect(db.query("SELECT cli,backend,session_id,pane_id FROM members WHERE id='m'").get()).toEqual({
            cli: "codex", backend: "headless", session_id: "native-old", pane_id: "terminal-old",
          });
          expect(db.query("SELECT body,delivery FROM messages WHERE id='msg_한글'").get()).toEqual({ body: "원본 보고", delivery: "delivered" });
          expect(db.query("SELECT title FROM decisions").get()).toEqual({ title: "기존 질문" });
          expect(db.query("SELECT title FROM todos").get()).toEqual({ title: "기존 업무" });
          expect(db.query("SELECT title FROM work").get()).toEqual({ title: "진행 중 업무" });
          expect(db.query("SELECT body FROM files").get()).toEqual({ body: "자료 본문" });
          expect(db.query("SELECT size,path FROM attachments").get()).toEqual({ size: 3, path: "/fixture/attachment" });
          expect(db.query("SELECT marker,phase,version FROM delivery_recovery WHERE delivery_id='d'").get()).toEqual({ marker: null, phase: "none", version: 1 });
        }
        expect(backups(runtime)).toHaveLength(prefix > 0 && prefix < MIGRATIONS.length ? 1 : 0);
      } finally { db.close(); }
      openDb(path).close();
      expect(backups(runtime)).toHaveLength(prefix > 0 && prefix < MIGRATIONS.length ? 1 : 0);
    }
  });

  test("pre-migration snapshot includes committed WAL and preserves measured windows, nonce state stays lazy", () => {
    const { runtime, path } = fixture("it's-a-db.sqlite");
    const old = track(historicalDb(path, afterWindow));
    old.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    old.query("UPDATE members SET context_window=1000000,context_window_source='statusline',context_pct=19,session_generation=7 WHERE id='m'").run();
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    const db = track(openDb(path));
    const snapshot = track(new Database(join(runtime.paths.iamceoHome, backups(runtime)[0]!), { readonly: true }));
    expect(version(snapshot)).toBe(afterWindow);
    expect(columns(snapshot, "members")).not.toContain("config_revision");
    expect(snapshot.query("SELECT name FROM sqlite_schema WHERE name='delivery_recovery'").get()).toBeNull();
    for (const connection of [db, snapshot]) {
      expect(connection.query("SELECT context_window,context_window_source,context_pct,session_generation FROM members WHERE id='m'").get()).toEqual({
        context_window: 1_000_000, context_window_source: "statusline", context_pct: 19, session_generation: 7,
      });
    }
    expect(statSync(join(runtime.paths.iamceoHome, backups(runtime)[0]!)).mode & 0o777).toBe(0o600);
    expect(db.query("SELECT * FROM member_context_state").all()).toEqual([]);
    expect(db.query("SELECT config_revision,now_at,manual_activity_at FROM members WHERE id='m'").get()).toEqual({ config_revision: 0, now_at: null, manual_activity_at: null });
    expect(db.query("SELECT board_revision,board_requested_revision,board_completed_revision,board_reviewed_revision FROM projects WHERE id='p'").get()).toEqual({
      board_revision: 0, board_requested_revision: null, board_completed_revision: null, board_reviewed_revision: null,
    });
  });

  test("reports written under the earlier runner are not re-sent to the lead after upgrade; new reports are tracked", () => {
    // Live schema on 2026-11-07 was v12. Its runner delivered worker reports without a message ref, so the
    // startup repair used to queue every historical report (397 on the live copy) to the leads again.
    const { path } = fixture();
    historicalDb(path, 12).close();
    const db = track(openDb(path));
    const store = new Store(db, new Bus());
    expect(store.listReportsMissingDeliveries().map((m) => m.id)).toEqual([]);
    db.query(`INSERT INTO messages (id,project_id,at,member_id,kind,body,delivery) VALUES ('msg_after','p',?,'m','완료','새 보고','')`).run(at);
    expect(store.listReportsMissingDeliveries().map((m) => m.id)).toEqual(["msg_after"]);
  });

  test("WAL-mode DB copied without its -wal/-shm side files still opens, backs up and migrates", () => {
    // `sqlite3 .backup`, a file-only copy or a restore of just iamceo.db leaves a WAL-mode file with no side files.
    // A read-only connection cannot create the shared-memory file there (SQLITE_CANTOPEN), which used to stop the server.
    const { runtime, path } = fixture();
    const old = historicalDb(path, afterWindow);
    old.exec("PRAGMA journal_mode=WAL");
    old.close();
    for (const side of [`${path}-wal`, `${path}-shm`]) rmSync(side, { force: true });
    const before = readFileSync(path);
    const db = track(openDb(path));
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.query("SELECT body FROM messages WHERE id='msg_한글'").get()).toEqual({ body: "원본 보고" });
    expect(backups(runtime)).toHaveLength(1);
    const snapshot = track(new Database(join(runtime.paths.iamceoHome, backups(runtime)[0]!), { readonly: true }));
    expect(version(snapshot)).toBe(afterWindow);
    expect(before.length).toBeGreaterThan(0);
  });

  test("future WAL-mode DB without side files is still refused and its bytes stay unchanged", () => {
    const { runtime, path } = fixture();
    const raw = new Database(path, { create: true });
    raw.exec(`PRAGMA journal_mode=WAL; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version=${MIGRATIONS.length + 1};`);
    raw.close();
    for (const side of [`${path}-wal`, `${path}-shm`]) rmSync(side, { force: true });
    const before = readFileSync(path);
    expect(() => openDb(path)).toThrow("미래 DB 스키마");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(backups(runtime)).toEqual([]);
  });

  test("future schema is refused before journal mode, permissions, bytes or directory contents change", () => {
    const { runtime, path } = fixture();
    const raw = new Database(path, { create: true });
    raw.exec(`CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version=${MIGRATIONS.length + 1};`);
    raw.close();
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    const names = readdirSync(runtime.paths.iamceoHome);
    expect(() => openDb(path)).toThrow("미래 DB 스키마");
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(runtime.paths.iamceoHome)).toEqual(names);
    const unchanged = track(new Database(path, { readonly: true }));
    expect(unchanged.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(version(unchanged)).toBe(MIGRATIONS.length + 1);
    expect(unchanged.query("SELECT * FROM future_data").all()).toEqual([{ value: "keep" }]);
  });

  test("real VACUUM backup failure leaves source bytes, mode, schema and version unchanged", () => {
    // The DB basename fits NAME_MAX, but the appended backup name cannot. No permission/root assumptions or mocks.
    const { runtime, path } = fixture(`${"d".repeat(235)}.db`);
    historicalDb(path, afterWindow).close();
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    const names = readdirSync(runtime.paths.iamceoHome);
    expect(() => openDb(path)).toThrow("마이그레이션 전 백업을 만들지 못했습니다");
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(runtime.paths.iamceoHome)).toEqual(names);
    const raw = track(new Database(path, { readonly: true }));
    expect(version(raw)).toBe(afterWindow);
    expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    expect(raw.query("SELECT name FROM sqlite_schema WHERE name='messages_project_page'").get()).toBeNull();
  });

  test("future WAL left by a stopped process is refused without checkpointing its data", () => {
    const { runtime, path } = fixture();
    leaveCommittedWal(runtime, path, MIGRATIONS.length + 1);
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    const wal = readFileSync(`${path}-wal`);
    const names = readdirSync(runtime.paths.iamceoHome);
    expect(() => openDb(path)).toThrow("미래 DB 스키마");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readFileSync(`${path}-wal`).equals(wal)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(runtime.paths.iamceoHome)).toEqual(names);
  });

  test("backup failure also leaves crash WAL contents and source permissions unchanged", () => {
    const { runtime, path } = fixture(`${"w".repeat(235)}.db`);
    historicalDb(path, afterWindow).close();
    leaveCommittedWal(runtime, path, afterWindow);
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    const wal = readFileSync(`${path}-wal`);
    const names = readdirSync(runtime.paths.iamceoHome);
    expect(() => openDb(path)).toThrow("마이그레이션 전 백업을 만들지 못했습니다");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readFileSync(`${path}-wal`).equals(wal)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(runtime.paths.iamceoHome)).toEqual(names);
  });

  test("negative schema version is rejected before migration or permission changes", () => {
    const { path } = fixture();
    const raw = new Database(path, { create: true });
    raw.exec("PRAGMA user_version=-1");
    raw.close();
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    expect(() => openDb(path)).toThrow("잘못된 DB 스키마 버전");
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  test("version-zero populated DB is also backed up before migration failure", () => {
    const { runtime, path } = fixture();
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE projects (legacy TEXT); INSERT INTO projects VALUES ('preserve')");
    raw.close();
    expect(() => openDb(path)).toThrow();
    expect(backups(runtime)).toHaveLength(1);
    const snapshot = track(new Database(join(runtime.paths.iamceoHome, backups(runtime)[0]!), { readonly: true }));
    expect(version(snapshot)).toBe(0);
    expect(snapshot.query("SELECT * FROM projects").all()).toEqual([{ legacy: "preserve" }]);
  });

  test("a failed stage rolls back all its DDL and version, earlier stages commit and reopen resumes", () => {
    const { runtime, path } = fixture();
    historicalDb(path, afterWindow).close();
    const stage = MIGRATIONS.findIndex((sql) => sql.includes("CREATE TABLE delivery_recovery"));
    const sql = MIGRATIONS[stage]!;
    try {
      MIGRATIONS[stage] = `${sql}\nINSERT INTO nonexistent_migration_fault VALUES (1);`;
      expect(() => openDb(path)).toThrow("nonexistent_migration_fault");
    } finally { MIGRATIONS[stage] = sql; }
    const partial = new Database(path);
    try {
      expect(version(partial)).toBe(stage);
      expect(partial.query("SELECT name FROM sqlite_schema WHERE name='messages_project_page'").get()).not.toBeNull();
      expect(partial.query("SELECT name FROM sqlite_schema WHERE name LIKE 'delivery_recovery%'").all()).toEqual([]);
      expect(columns(partial, "activity")).not.toContain("delivery_event_key");
      expect(partial.query("SELECT body FROM messages").get()).toEqual({ body: "원본 보고" });
      // The failed open must have closed its connection and transaction.
      partial.exec("BEGIN EXCLUSIVE; ROLLBACK;");
    } finally { partial.close(); }
    const db = track(openDb(path));
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(backups(runtime)).toHaveLength(2);
  });
});

describe("persistence contracts", () => {
  function ready(): Database {
    const { path } = fixture();
    historicalDb(path, afterWindow).close();
    return track(openDb(path));
  }

  test("paging indexes seek tuples including identical timestamps and Unicode IDs", () => {
    const db = ready();
    const insert = db.query("INSERT INTO messages (id,project_id,at,member_id,target_member_id,kind) VALUES (?,'p',?,'m','m','진행')");
    db.transaction(() => {
      for (let i = 0; i < 1_205; i++) insert.run(`msg_${String(i).padStart(4, "0")}`, at);
      for (const id of ["msg_é", "msg_한", "msg_😀", "msg_\uE000"]) insert.run(id, at);
    })();
    for (const [index, filter] of [["messages_project_page", ""], ["messages_member_page", " AND member_id='m'"], ["messages_target_page", " AND target_member_id='m'"]]) {
      const sql = `SELECT id,at FROM messages WHERE project_id='p'${filter} AND (at,id) < (?,?) ORDER BY at DESC,id DESC LIMIT 101`;
      const plan = db.query<{ detail: string }, [string, string]>(`EXPLAIN QUERY PLAN ${sql}`).all(at, "zz");
      expect(plan.some((row) => row.detail.includes(index!) && row.detail.includes("SEARCH"))).toBe(true);
      expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
    }
    const expected = db.query<{ id: string }, []>("SELECT id FROM messages WHERE project_id='p' ORDER BY at DESC,id DESC").all().map((row) => row.id);
    const actual: string[] = [];
    let boundary = { at: "9999", id: "z" };
    for (;;) {
      const page = db.query<{ id: string; at: string }, [string, string]>("SELECT id,at FROM messages WHERE project_id='p' AND (at,id) < (?,?) ORDER BY at DESC,id DESC LIMIT 100").all(boundary.at, boundary.id);
      if (!page.length) break;
      actual.push(...page.map((row) => row.id));
      boundary = page[page.length - 1]!;
    }
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(expected.length);
  });

  test("delivery markers, ordinals, submit limit, CAS versions and activity keys are constrained", () => {
    const db = ready();
    expect(() => db.exec("UPDATE delivery_recovery SET version=0 WHERE delivery_id='d'")).toThrow();
    expect(() => db.exec("UPDATE delivery_recovery SET phase='received' WHERE delivery_id='d'")).toThrow();
    expect(() => db.exec("UPDATE delivery_recovery SET active_check_ms=-1 WHERE delivery_id='d'")).toThrow();
    db.query(`INSERT INTO delivery_dispatches
      (id,project_id,member_id,bundle_marker,cli,backend,generation,terminal_identity_json,baseline_json,wire_text,wire_sha256,transport_state,created_at,updated_at)
      VALUES ('dispatch','p','m','#bundle','codex','core',0,'{}','{}','wire','hash','unknown',?,?)`).run(at, at);
    db.exec("INSERT INTO delivery_dispatch_items VALUES ('dispatch','d',0,'source-v1')");
    expect(() => db.exec("INSERT INTO delivery_dispatch_items VALUES ('dispatch','d',1,'source-v1')")).toThrow();
    expect(() => db.exec("UPDATE delivery_dispatches SET submit_attempts=2")).toThrow();
    db.query("INSERT INTO activity (member_id,at,kind,text,delivery_event_key) VALUES ('m',?,'system','checked','dispatch:d:resolved:1')").run(at);
    expect(() => db.query("INSERT INTO activity (member_id,at,kind,text,delivery_event_key) VALUES ('m',?,'system','duplicate','dispatch:d:resolved:1')").run(at)).toThrow();
    db.query("INSERT INTO activity (member_id,at,kind,text) VALUES ('m',?,'system','legacy')").run(at);
    db.query("INSERT INTO activity (member_id,at,kind,text) VALUES ('m',?,'system','legacy')").run(at);
    expect(() => db.query("INSERT INTO member_context_state (member_id,generation,binding_nonce,updated_at) VALUES ('missing',0,'nonce',?)").run(at)).toThrow();
  });

  test("journal, lease, receipt, retry and board review identities survive reopening", () => {
    const { path } = fixture();
    historicalDb(path, afterWindow).close();
    const db = openDb(path);
    const due = "2026-11-07T00:05:00.123Z";
    try {
      db.query(`INSERT INTO lifecycle_journal (operation_id,member_id,project_id,intent,phase,generation,terminal_identity_json,reason,exit_code,created_at,updated_at)
        VALUES ('start-op','m','p','start','unknown',7,'{"terminalId":"terminal-old"}','run_response_lost',1,?,?)`).run(at, at);
      db.query(`INSERT INTO execution_journal (run_id,member_id,project_id,generation,terminal_identity_json,delivery_ids_json,phase,reason,exit_code,created_at,updated_at)
        VALUES ('run','m','p',7,'{"terminalId":"terminal-old"}','["d"]','interrupted','process_exit',1,?,?)`).run(at, at);
      db.query("INSERT INTO terminal_leases VALUES ('m','claim','lease',7,'{\"terminalId\":\"terminal-old\"}',?,3)").run(Date.parse(due));
      db.query(`INSERT INTO operation_receipts (operation_id,kind,project_id,member_id,status,request_json,code,error,created_at,updated_at)
        VALUES ('input-op','terminal_control','p','m','unknown','{"claimId":"claim","inputSequence":3}','INPUT_UNKNOWN','결과 확인 중',?,?)`).run(at, at);
      expect(() => db.exec("UPDATE operation_receipts SET status='applied' WHERE operation_id='input-op'")).toThrow();
      expect(() => db.query("INSERT INTO terminal_leases VALUES ('m','other-claim','other-lease',7,'{}',?,0)").run(Date.parse(due))).toThrow();
      db.query("UPDATE deliveries SET next_attempt_at=?,retry_scope='fixture-provider',retry_reason='quota' WHERE id='d'").run(due);
      db.exec("UPDATE members SET config_revision=4 WHERE id='m'; UPDATE todos SET revision=2 WHERE id='todo'; UPDATE domain_revisions SET revision=3 WHERE domain='settings';");
      db.exec("UPDATE projects SET board_revision=9,board_requested_revision=7,board_completed_revision=7,board_reviewed_revision=6 WHERE id='p'");
      db.query("INSERT INTO member_context_state (member_id,generation,binding_nonce,compaction_json,updated_at) VALUES ('m',7,'stable-nonce','{\"phase\":\"uncertain\"}',?)").run(at);
    } finally { db.close(); }
    const reopened = track(openDb(path));
    expect(reopened.query("SELECT phase,reason,exit_code,generation FROM lifecycle_journal").get()).toEqual({ phase: "unknown", reason: "run_response_lost", exit_code: 1, generation: 7 });
    expect(reopened.query("SELECT delivery_ids_json,phase,exit_code FROM execution_journal").get()).toEqual({ delivery_ids_json: '["d"]', phase: "interrupted", exit_code: 1 });
    expect(reopened.query("SELECT claim_id,generation,expires_at,last_input_sequence FROM terminal_leases").get()).toEqual({ claim_id: "claim", generation: 7, expires_at: Date.parse(due), last_input_sequence: 3 });
    expect(reopened.query("SELECT status,code FROM operation_receipts").get()).toEqual({ status: "unknown", code: "INPUT_UNKNOWN" });
    expect(reopened.query("SELECT next_attempt_at FROM deliveries WHERE id='d'").get()).toEqual({ next_attempt_at: due });
    expect(reopened.query("SELECT config_revision FROM members WHERE id='m'").get()).toEqual({ config_revision: 4 });
    expect(reopened.query("SELECT revision FROM todos WHERE id='todo'").get()).toEqual({ revision: 2 });
    expect(reopened.query("SELECT revision FROM domain_revisions WHERE domain='settings'").get()).toEqual({ revision: 3 });
    expect(reopened.query("SELECT board_revision,board_requested_revision,board_completed_revision,board_reviewed_revision FROM projects").get()).toEqual({
      board_revision: 9, board_requested_revision: 7, board_completed_revision: 7, board_reviewed_revision: 6,
    });
    expect(reopened.query("SELECT binding_nonce,compaction_json FROM member_context_state").get()).toEqual({ binding_nonce: "stable-nonce", compaction_json: '{"phase":"uncertain"}' });
    reopened.exec("DELETE FROM members WHERE id='m'");
    // Closing a member must not erase the operation outcome or initial failure evidence.
    expect(reopened.query("SELECT COUNT(*) AS n FROM lifecycle_journal").get()).toEqual({ n: 1 });
    expect(reopened.query("SELECT COUNT(*) AS n FROM execution_journal").get()).toEqual({ n: 1 });
    expect(reopened.query("SELECT COUNT(*) AS n FROM operation_receipts").get()).toEqual({ n: 1 });
    expect(reopened.query("SELECT * FROM terminal_leases").all()).toEqual([]);
    expect(reopened.query("SELECT * FROM member_context_state").all()).toEqual([]);
    expect(reopened.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("push defaults, enums, token generation, event and device fanout uniqueness", () => {
    const db = ready();
    insertDevice(db, "device-a", "token");
    insertDevice(db, "device-b", "token", "production");
    insertDevice(db, "revoked-a");
    insertDevice(db, "revoked-b");
    const device = db.query<{ enabled: number; preferences: string; revision: number; registration_generation: number }, []>("SELECT enabled,preferences,revision,registration_generation FROM push_devices WHERE id='device-a'").get()!;
    expect(device.enabled).toBe(0);
    expect(JSON.parse(device.preferences)).toEqual(DEFAULT_PUSH_PREFERENCES);
    expect(device.revision).toBe(1);
    expect(device.registration_generation).toBe(1);
    expect(() => insertDevice(db, "duplicate", "token")).toThrow();
    for (const change of ["enabled=2", "platform='macos'", "environment='test'", "authorization='unknown'", "state='unknown'", "revision=0", "registration_generation=0", "last_failure='raw-secret'"])
      expect(() => db.exec(`UPDATE push_devices SET ${change} WHERE id='device-a'`)).toThrow();
    for (const kind of ["decision", "approval_wait", "error", "report_complete", "test"]) {
      db.query("INSERT INTO push_events VALUES (?,?,?,'p','m','{}',?,?)").run(kind, `source:${kind}`, kind, at, at);
    }
    expect(() => db.query("INSERT INTO push_events VALUES ('other','source:decision','decision',NULL,NULL,'{}',?,?)").run(at, at)).toThrow();
    expect(() => db.query("INSERT INTO push_events VALUES ('question','source:question','question',NULL,NULL,'{}',?,?)").run(at, at)).toThrow();
    db.query("INSERT INTO push_deliveries (id,event_id,device_id,registration_generation,state,next_attempt_at,expires_at) VALUES ('push','decision','device-a',1,'unknown',?,?)").run(at, at);
    expect(() => db.query("INSERT INTO push_deliveries (id,event_id,device_id,registration_generation,state,next_attempt_at,expires_at) VALUES ('dup','decision','device-a',2,'queued',?,?)").run(at, at)).toThrow();
    db.exec("DELETE FROM members WHERE id='m'; DELETE FROM projects WHERE id='p'");
    // Events retain immutable source IDs after domain deletion; device/event cleanup still cascades deliveries.
    expect(db.query("SELECT project_id,member_id FROM push_events WHERE id='decision'").get()).toEqual({ project_id: "p", member_id: "m" });
    db.exec("DELETE FROM push_events WHERE id='decision'");
    expect(db.query("SELECT * FROM push_deliveries").all()).toEqual([]);
  });

  test("fixed 120s groups keep report order, original recipients, cancellation and one event across restart", () => {
    const { path } = fixture();
    historicalDb(path, afterWindow).close();
    const db = openDb(path);
    const closesAt = new Date(Date.parse(at) + PUSH_REPORT_GROUP_WINDOW_MS).toISOString();
    try {
      insertDevice(db, "device-a");
      db.query("INSERT INTO push_meta VALUES (1,'persistent-server-id',?)").run(at);
      const insertGroup = db.query("INSERT INTO push_report_groups (id,project_id,member_id,opened_at,closes_at,last_message_id) VALUES (?, 'p', ?, ?, ?, 'report-2')");
      insertGroup.run("group", "m", at, closesAt);
      expect(() => insertGroup.run("duplicate", "m", at, closesAt)).toThrow();
      insertGroup.run("other-member", "other", at, closesAt);
      expect(() => insertGroup.run("extended", "third", at, new Date(Date.parse(at) + 121_000).toISOString())).toThrow();
      expect(() => insertGroup.run("invalid-time", "third", "invalid", closesAt)).toThrow();
      db.exec("INSERT INTO push_report_group_reports VALUES ('group','report-1',0),('group','report-2',1)");
      expect(() => db.exec("INSERT INTO push_report_group_reports VALUES ('other-member','report-1',0)")).toThrow();
      db.exec("INSERT INTO push_report_group_recipients (group_id,device_id,registration_generation) VALUES ('group','device-a',1)");
      insertDevice(db, "late-device");
      db.query("UPDATE push_report_group_recipients SET cancelled_at=? WHERE group_id='group' AND device_id='device-a'").run(at);
      db.exec("UPDATE push_devices SET enabled=1,registration_generation=2 WHERE id='device-a'");
    } finally { db.close(); }
    const reopened = track(openDb(path));
    expect(reopened.query("SELECT server_id FROM push_meta").get()).toEqual({ server_id: "persistent-server-id" });
    expect(reopened.query("SELECT opened_at,closes_at,last_message_id,state FROM push_report_groups WHERE id='group'").get()).toEqual({ opened_at: at, closes_at: closesAt, last_message_id: "report-2", state: "open" });
    expect(reopened.query("SELECT message_id FROM push_report_group_reports WHERE group_id='group' ORDER BY ordinal").all()).toEqual([{ message_id: "report-1" }, { message_id: "report-2" }]);
    expect(reopened.query("SELECT device_id,registration_generation,cancelled_at FROM push_report_group_recipients WHERE group_id='group'").all()).toEqual([{ device_id: "device-a", registration_generation: 1, cancelled_at: at }]);
    reopened.transaction(() => {
      reopened.query("INSERT INTO push_events VALUES ('group-event','group:group','report_complete','p','m','{}',?,?)").run(closesAt, closesAt);
      reopened.query("UPDATE push_report_groups SET state='closed',event_id='group-event',closed_at=? WHERE id='group' AND state='open'").run(closesAt);
    })();
    expect(() => reopened.query("INSERT INTO push_events VALUES ('event-again','group:group','report_complete','p','m','{}',?,?)").run(closesAt, closesAt)).toThrow();
    expect(() => reopened.exec("UPDATE push_report_groups SET event_id='group-event' WHERE id='other-member'")).toThrow();
    // A new window is allowed after the prior one closes, never by resurrecting its recipient rows.
    reopened.query("INSERT INTO push_report_groups (id,project_id,member_id,opened_at,closes_at,last_message_id) VALUES ('next','p','m',?,?,'report-3')").run(closesAt, new Date(Date.parse(closesAt) + PUSH_REPORT_GROUP_WINDOW_MS).toISOString());
    expect(reopened.query("SELECT * FROM push_report_group_recipients WHERE group_id='next'").all()).toEqual([]);
  });
});

test("v40 upgrade and Store reconstruction preserve an existing global concurrency of twenty", () => {
  expect(MIGRATIONS[39]).toContain("ALTER TABLE projects ADD COLUMN max_concurrent_turns");
  const { path } = fixture("global-limit-20.db"), old = historicalDb(path, 40);
  old.query("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run("maxConcurrentTurns", "20");
  old.query("UPDATE projects SET max_concurrent_turns = 2 WHERE id = 'p'").run();
  old.close();
  const migrated = track(openDb(path));
  const store = new Store(migrated, new Bus());
  expect(store.getSettings().maxConcurrentTurns).toBe(20);
  expect(store.requireProject("p").maxConcurrentTurns).toBe(2);
  expect(migrated.query("SELECT value FROM settings WHERE key = 'maxConcurrentTurns'").get()).toEqual({ value: "20" });
  expect(columns(migrated, "members")).toContain("execution_issue_json");
  expect(new Store(migrated, new Bus()).getSettings().maxConcurrentTurns).toBe(20);
});

test("v54 automatic completion backfills active cards once and respects later board and stage edits", () => {
  const { path } = fixture("completion-board.db"), old = historicalDb(path, 54);
  const later = "2026-11-09T00:00:00.000Z", completed = "2026-11-08T00:00:00.000Z";
  const task = old.query("INSERT INTO tasks(id,project_id,title,created_at,updated_at) VALUES(?,'p',?,?,?)");
  const mark = old.query("INSERT INTO task_stage_marks(project_id,task_id,stage,evidence,who,at) VALUES('p',?,?,'검사 근거','하네스',?)");
  const receipt = old.query("INSERT INTO task_completion_reviews(task_id,report_id,contract_task_id,contract_rev,mark_id,status,completed_at) VALUES(?,'msg_한글',?,1,?,'pending',?)");
  const card = old.query("INSERT INTO work(id,project_id,task_id,sec,title,sort_order,created_at,updated_at) VALUES(?,'p',?,?,?,1,?,?)");
  for (const id of ["tk_w_legacy", "reopened", "manual"]) {
    task.run(id, id, at, at);
    const done = mark.run(id, "done", completed);
    if (id !== "manual") receipt.run(id, id, done.lastInsertRowid, completed);
    if (id === "reopened") mark.run(id, "reopen", later);
  }
  card.run("w_legacy", null, "next", "옛 연결", at, at);
  card.run("explicit", "tk_w_legacy", "doing", "저장된 연결", at, at);
  card.run("edited", "tk_w_legacy", "doing", "나중에 움직인 일", at, later);
  card.run("hold", "tk_w_legacy", "hold", "보류", at, at);
  card.run("reopen", "reopened", "next", "다시 연 업무", at, at);
  card.run("manual", "manual", "doing", "수동 완료", at, at);
  old.close();

  const upgraded = openDb(path), store = new Store(upgraded, new Bus());
  for (const id of ["w_legacy", "explicit"]) expect(store.getWork(id)).toMatchObject({ sec: "done", doneAt: completed });
  expect(store.getWork("edited")?.sec).toBe("doing");
  expect(store.getWork("hold")?.sec).toBe("hold");
  expect(store.getWork("reopen")?.sec).toBe("next");
  expect(store.getWork("manual")?.sec).toBe("doing");
  store.upsertWork({ ...store.getWork("explicit")!, sec: "doing" });
  const revision = store.boardRevision("p");
  upgraded.close();
  const again = new Store(track(openDb(path)), new Bus());
  expect(again.getWork("explicit")?.sec).toBe("doing");
  expect(again.boardRevision("p")).toBe(revision);
  again.addStageMark({ projectId: "p", taskId: "tk_w_legacy", stage: "reopen", memberId: null, who: "대표", evidence: "새 조건" });
  expect(again.getWork("w_legacy")).toMatchObject({ sec: "next", doneAt: null });
});

const timerAt = "2026-11-07T02:01:00.123Z";
const timerReason = "진척 없이 121분(1번 시도)";
function legacyWatch(db: Database, id: string, reason = timerReason, same = 1) {
  db.query("INSERT INTO tasks(id,project_id,title,created_at,updated_at) VALUES(?,'p',?,?,?)").run(id, id, at, at);
  const history = ["다른 검사", "검사"].map((name,i) => ({ at, messageId: "msg_"+i, who: "기존 직원", fingerprint: "fail:"+name, failed: [name] }));
  db.query(`INSERT INTO task_watch(task_id,project_id,started_at,attempts,same_count,fingerprint,last_progress_at,tripped_at,trip_reason,history_json,updated_at)
    VALUES(?,'p',?,2,?,'fail:검사',?,?,?,?,?)`).run(id, at, same, at, timerAt, reason, JSON.stringify(history), timerAt);
}

test("v57 restores only elapsed-time stops, keeps other gates and failure history, and never replays the release", () => {
  const { path, runtime } = fixture(), old = historicalDb(path, 56);
  for (const id of ["timer", "hold", "owner", "paused", "escalated", "changed"]) legacyWatch(old, id);
  legacyWatch(old, "subminute", "진척 없이 0분(1번 시도)");
  legacyWatch(old, "early", "진척 없이 5분(1번 시도)");
  legacyWatch(old, "repeat", "같은 실패 3번(검사)", 3);
  legacyWatch(old, "late-repeats", timerReason, 3);
  legacyWatch(old, "past-repeats", timerReason, 1);
  const intervening = ["a","a","a","b"].map((fingerprint,i) => ({ at, fingerprint, who:"기존 직원", failed:[], messageId:"m"+i }));
  old.query("UPDATE task_watch SET attempts=4,history_json=? WHERE task_id='past-repeats'").run(JSON.stringify(intervening));
  legacyWatch(old, "followup", "후속 조정 요청 3회 뒤에도 완료 근거가 바뀌지 않았습니다.");
  legacyWatch(old, "custom", timerReason + " 검수자가 직접 보류");
  old.query("INSERT INTO task_stage_marks(project_id,task_id,stage,evidence,who,at) VALUES('p','hold','hold','직접 보류','총괄',?)").run(timerAt);
  old.exec("UPDATE decisions SET task_id='owner' WHERE id='decision'");
  old.query("INSERT INTO task_failure_escalations(task_id,decision_id,tripped_at,created_at) VALUES('escalated','decision',?,?)").run(timerAt,timerAt);
  old.query("INSERT INTO task_continuations(task_id,project_id,pause_token,pause_reason,paused_at,updated_at) VALUES('paused','p','pause','대표가 중단',?,?)").run(at, at);
  const saved = old.query<Record<string, unknown>, []>("SELECT * FROM task_watch WHERE task_id='timer'").get()!;
  old.close();

  expect(optimizeStorage(runtime.paths.iamceoHome).verified).toBe(true);
  const db = openDb(path);
  const preview = new Store(db, new Bus(), undefined, { readOnly: true });
  expect(preview.getTaskWatch("timer")?.trippedAt).toBe(timerAt);
  db.exec("UPDATE task_watch SET trip_reason='총괄이 추가 점검을 요청했습니다' WHERE task_id='changed'");
  const store = new Store(db, new Bus());
  expect(store.pendingTaskIntervention("timer")).toBeNull();
  for (const id of ["early", "subminute"]) expect(store.pendingTaskIntervention(id)).toBeNull();
  expect(db.query("SELECT * FROM task_watch WHERE task_id='timer'").get()).toEqual({ ...saved, tripped_at: null, trip_reason: null, notice_delivery_id: null });
  for (const id of ["repeat","late-repeats","past-repeats","followup","custom","escalated","changed"]) expect(store.getTaskWatch(id)?.trippedAt).toBe(timerAt);
  expect(store.pendingTaskFailureDecision("escalated")?.id).toBe("decision");
  expect(store.taskProgress("hold").stage).toBe("hold");
  expect(store.taskProgress("owner").stage).toBe("owner");
  expect(db.query("SELECT pause_token,pause_reason,paused_at FROM task_continuations WHERE task_id='paused'").get())
    .toEqual({pause_token:"pause",pause_reason:"대표가 중단",paused_at:at});
  expect(db.query("SELECT count(*) AS n FROM task_stage_marks WHERE stage='reopen'").get()).toEqual({n:0});
  store.saveTaskWatch("p","timer",{ ...store.getTaskWatch("timer")!, trippedAt:timerAt, reason:"같은 실패 3번(검사)", same:3 });
  expect(store.claimWatchNotice("timer","new-notice")).toBe(true);
  db.close();
  const reopened = new Store(track(openDb(path)),new Bus());
  expect(reopened.getTaskWatch("timer")?.reason).toBe("같은 실패 3번(검사)");
  expect(reopened.watchNoticeSent("timer")).toBe(true);
});

test("v57 retires only a proven untouched timer notice and preserves delivered and physically uncertain envelopes", () => {
  const { path } = fixture("timer-notices.db"), old = historicalDb(path,56);
  const cases = ["fresh","delivered","attempted","checking","manual","revised","no-recovery","receipt","older","executed","dispatch","wrong-task","other-body","other-episode"];
  const body = (id: string) => `[시스템] 반복 감시: 업무 #${id} '기존 업무'의 막힘이 ${timerReason}. 이 업무의 자동 반복을 멈췄습니다.`;
  for (const id of cases) {
    legacyWatch(old,id);
    const text = id === "other-body" ? "다른 시스템 지시" : id === "other-episode" ? body(id).replace(timerReason,"같은 실패 3번(검사)") : body(id);
    old.query("INSERT INTO deliveries(id,project_id,member_id,task_id,kind,text,status,created_at) VALUES(?,'p','m',?,'system',?,'queued',?)")
      .run("n-"+id, id === "wrong-task" ? "fresh" : id, text, timerAt);
    old.query("INSERT INTO delivery_recovery(delivery_id,updated_at) VALUES(?,?)").run("n-"+id,timerAt);
    old.query("UPDATE task_watch SET notice_delivery_id=? WHERE task_id=?").run("n-"+id,id);
  }
  old.exec("UPDATE deliveries SET status='delivered', delivered_at=created_at WHERE id='n-delivered'; UPDATE deliveries SET attempts=1 WHERE id='n-attempted'");
  old.exec("UPDATE delivery_recovery SET phase='checking' WHERE delivery_id='n-checking'; UPDATE delivery_recovery SET version=2 WHERE delivery_id='n-revised'");
  old.exec("DELETE FROM delivery_recovery WHERE delivery_id='n-no-recovery'");
  old.query("UPDATE deliveries SET created_at=? WHERE id='n-older'").run(at);
  old.query("INSERT INTO workflow_assignment_receipts VALUES('assignment','p','receipt','m','n-receipt','{}',?)").run(at);
  old.query("INSERT INTO manual_inbox_batches(id,member_id,created_at) VALUES('batch','m',?)").run(at);
  old.exec("INSERT INTO manual_inbox_items VALUES('batch','n-manual',0)");
  old.query(`INSERT INTO execution_journal(run_id,member_id,project_id,generation,terminal_identity_json,delivery_ids_json,phase,created_at,updated_at)
    VALUES('run','m','p',1,'{}','["n-executed"]','starting',?,?)`).run(at,at);
  old.query(`INSERT INTO delivery_dispatches(id,project_id,member_id,bundle_marker,cli,backend,generation,terminal_identity_json,baseline_json,wire_text,wire_sha256,transport_state,created_at,updated_at)
    VALUES('dispatch','p','m','marker','codex','headless',1,'{}','{}','old','x','write_started',?,?)`).run(at,at);
  old.exec("INSERT INTO delivery_dispatch_items(dispatch_id,delivery_id,ordinal) VALUES('dispatch','n-dispatch',0)");
  const retained = (db:Database) => db.query("SELECT d.*,r.* FROM deliveries d LEFT JOIN delivery_recovery r ON r.delivery_id=d.id WHERE d.id <> 'n-fresh' ORDER BY d.id").all();
  const kept = retained(old);
  old.close();

  const db = track(openDb(path)), store = new Store(db,new Bus());
  expect(store.requireDelivery("n-fresh")).toMatchObject({status:"failed", wake:false, attempts:0, deliveredAt:null, text:body("fresh")});
  expect(store.getDeliveryRecovery("n-fresh")?.phase).toBe("stopped");
  expect(retained(db)).toEqual(kept);
  expect(store.watchNoticeSent("fresh")).toBe(false);
  expect(store.claimWatchNotice("fresh","next-genuine-notice")).toBe(true);
  expect(db.query("SELECT tripped_at,trip_reason,notice_delivery_id FROM legacy_task_timer_stops WHERE task_id='fresh'").get())
    .toEqual({tripped_at:timerAt,trip_reason:timerReason,notice_delivery_id:"n-fresh"});
});

test("after v57 the normal coordinator continues an authorized timed-out task exactly once", () => {
  const { path, runtime } = fixture("timer-continuation.db"), old = historicalDb(path, 56);
  old.query("UPDATE projects SET cwd=? WHERE id='p'").run(runtime.paths.work);
  const prior = new Store(old,new Bus());
  const lead = prior.createMember({ projectId:"p", handle:"lead", name:"총괄", kind:"conductor", origin:"runner", backend:"core", status:"idle", cwd:runtime.paths.work });
  for (const id of ["ready","held","owner"]) {
    legacyWatch(old,id);
    old.query("UPDATE tasks SET origin='owner' WHERE id=?").run(id);
    const assignment = prior.enqueue({projectId:"p",memberId:"m",taskId:id,kind:"instruction",text:"계약의 미완료 조건을 확인합니다"});
    prior.markDelivered(assignment.id);
  }
  prior.addStageMark({projectId:"p",taskId:"held",stage:"hold",evidence:"명시적 보류",memberId:lead.id,who:lead.name});
  old.exec("UPDATE decisions SET task_id='owner' WHERE id='decision'");
  const coordinator = (s:Store) => new TaskContinuationCoordinator(s, { intervalMs:1000, sameLimit:3 });
  const before = coordinator(prior).check(Date.now()+2000, member => member.id === lead.id);
  expect(before.map(d => d.taskId)).toEqual(["ready"]);
  expect(before[0]?.text).toContain(timerReason);
  old.close();

  const db = openDb(path), current = new Store(db,new Bus());
  const next = coordinator(current).check(Date.now()+3000, member => member.id === lead.id);
  expect(next.map(d => d.taskId)).toEqual(["ready"]);
  expect(next[0]?.text).toContain("업무 계속 진행");
  expect(current.requireDelivery(before[0]!.id)).toMatchObject({status:"failed",wake:false});
  db.close();
  const again = new Store(track(openDb(path)),new Bus());
  expect(coordinator(again).check(Date.now()+4500, member => member.id === lead.id)).toEqual([]);
  expect(again.taskProgress("owner").stage).toBe("owner");
  expect(again.taskProgress("held").stage).toBe("hold");
});
