// Historical synthetic databases only. No operational home, report or execution log is opened.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MIGRATIONS, openDb } from "../server/db.ts";

const at = "2026-01-01T00:00:00.000Z";
const command = "bun  test 'synthetic 한글.ts'";
const workdir = "/synthetic/review results/한글%";
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function seed(db: Database, version: number) {
  db.query("INSERT INTO projects(id,name,cwd,runner_enabled,created_at,updated_at) VALUES('p','합성 프로젝트','/synthetic',0,?,?)").run(at, at);
  db.query("INSERT INTO members(id,project_id,handle,name,kind,origin,cli,status,cwd,token,created_at,updated_at) VALUES('m','p','synthetic','합성 직원','worker','runner','codex','idle','/synthetic','fixture-only',?,?)").run(at, at);
  db.query("INSERT INTO tasks(id,project_id,member_id,who,title,created_at,updated_at) VALUES('t','p','m','합성 직원','보존할 업무',?,?)").run(at, at);
  db.query("INSERT INTO deliveries(id,project_id,member_id,task_id,kind,text,status,created_at) VALUES('d','p','m','t','instruction','합성 원문','held',?)").run(at);
  db.query("INSERT INTO report_checks(message_id,idx,name,kind,result,evidence,command) VALUES('old',0,'옛 검사','behavior','fail','합성 과거 행',?)").run(command);
  if (version >= 36) {
    db.query("INSERT INTO task_stage_marks(project_id,task_id,stage,evidence,member_id,who,at) VALUES('p','t','hold','합성 보류','m','합성 직원',?)").run(at);
    db.query("INSERT INTO task_watch(task_id,project_id,started_at,attempts,same_count,fingerprint,last_progress_at,history_json,updated_at) VALUES('t','p',?,2,1,'synthetic-fingerprint',?,'[]',?)").run(at, at, at);
    db.query("INSERT INTO task_notices(id,project_id,task_id,mark_id,lines_json,created_at) VALUES('n','p','t',1,'[\"합성 알림\"]',?)").run(at);
  }
  if (version >= 37) db.query("INSERT INTO task_sequence(member_id,task_id,entered_at) VALUES('m','t',?)").run(at);
  if (version >= 38) {
    db.query("INSERT INTO task_continuations(task_id,project_id,source_delivery_id,evidence_key,round,no_progress_count,pause_reason,updated_at) VALUES('t','p','d','synthetic-progress',3,1,'synthetic hold',?)").run(at);
    db.query("INSERT INTO task_continuation_deliveries(delivery_id,task_id,round,created_at) VALUES('d','t',3,?)").run(at);
  }
  if (version >= 39) db.query("INSERT INTO workflow_assignment_receipts(operation_id,project_id,task_id,member_id,delivery_id,request_json,created_at) VALUES('synthetic-operation','p','t','m','d','{\"synthetic\":true}',?)").run(at);
  if (version >= 40) {
    db.query("UPDATE projects SET max_concurrent_turns=3 WHERE id='p'").run();
    db.query("INSERT INTO decisions(id,project_id,member_id,who,title,status,created_at) VALUES('synthetic-decision','p','m','합성 직원','합성 보류','open',?)").run(at);
    db.query("INSERT INTO task_failure_escalations(task_id,decision_id,tripped_at,trigger_message_id,created_at) VALUES('t','synthetic-decision',?,'synthetic-trigger',?)").run(at,at);
  }
  if (version >= 45) db.query("UPDATE members SET codex_speed='fast' WHERE id='m'").run();
  if (version >= 41) db.query("UPDATE members SET execution_issue_json=? WHERE id='m'").run(JSON.stringify({kind: 'quota', detail: 'synthetic fixture', at}));
}

function snapshot(db: Database) {
  const names = new Set(["projects", "members", "tasks", "deliveries", "decisions", "report_checks",
    ...db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'task_%' OR name='workflow_assignment_receipts')").all().map(r => r.name)]);
  return [...names].sort().map(table => {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(r => r.name);
    return { table, columns, rows: db.query(`SELECT ${columns.join(",")} FROM ${table} ORDER BY rowid`).all() };
  });
}

for (const version of [35, 37, 41, 42, 43, 44, 45, 46]) test(`v${version}→연결판 이주·재열기는 원 행/명령/과거NULL/명시 위치와 업무 상태를 보존한다`, () => {
  expect(MIGRATIONS[45]).toBe("ALTER TABLE report_checks ADD COLUMN workdir TEXT;");
  expect(MIGRATIONS[44]).toBe("ALTER TABLE members ADD COLUMN codex_speed TEXT NOT NULL DEFAULT 'standard' CHECK (codex_speed IN ('standard', 'fast'));");
  expect(MIGRATIONS[40]).toBe('ALTER TABLE members ADD COLUMN execution_issue_json TEXT;');
  const path = join(mkdtempSync(join(tmpdir(), `workdir-v${version}-`)), "synthetic.db");
  const old = new Database(path, { create: true });
  old.exec("PRAGMA foreign_keys=ON");
  for (let i = 0; i < version; i++) old.exec(MIGRATIONS[i]!);
  old.exec(`PRAGMA user_version=${version}`);
  seed(old, version);
  const before = snapshot(old);
  old.close();

  const db = openDb(path, { migrationBackup: false });
  try {
    // Query exactly the pre-existing columns: additive workflow metadata may legitimately be introduced.
    const after = before.map(s => ({ ...s, rows: db.query(`SELECT ${s.columns.join(",")} FROM ${s.table} ORDER BY rowid`).all() }));
    expect(digest(after)).toBe(digest(before));
    expect(db.query<{ name: string }, []>("PRAGMA table_info(report_checks)").all().filter(r => r.name === "workdir")).toHaveLength(1);
    expect(db.query("SELECT command,workdir FROM report_checks WHERE message_id='old'").get()).toEqual({ command, workdir: null });
    db.query("INSERT INTO report_checks(message_id,idx,name,kind,result,evidence,command,workdir) VALUES('new',0,'명시 위치','behavior','fail','합성 새 행',?,?)").run(command, workdir);
  } finally { db.close(); }
  const again = openDb(path, { migrationBackup: false });
  try {
    expect(again.query("SELECT command,workdir FROM report_checks ORDER BY message_id").all()).toEqual([{ command, workdir }, { command, workdir: null }]);
    const reopened = before.map(s => ({ ...s, rows: again.query(`SELECT ${s.columns.join(",")} FROM ${s.table} ${s.table === "report_checks" ? "WHERE message_id='old'" : ""} ORDER BY rowid`).all() }));
    expect(digest(reopened)).toBe(digest(before));
    expect(again.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
    console.info(JSON.stringify({ historicalVersion: version, baselineVersion: 45, connectedVersion: MIGRATIONS.length, existingTables: before.length,
      beforeSha256: digest(before), reopenedSha256: digest(reopened), commandSha256: digest(command),
      legacyWorkdir: null, explicitWorkdirPreserved: true }));
  } finally { again.close(); }
});
