import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openDb, MIGRATIONS, STORAGE_OPTIMIZATION_VERSION } from "../server/db.ts";
import { acquireHomeOwner, normalizeHome } from "../server/home-owner.ts";
import { canonicalAgentRequest, storageContentDigest } from "../server/agent-receipts.ts";

export interface StorageInspection {
  schemaVersion: number; fileBytes: number; allocatedBytes: number; freeBytes: number;
  receiptCount: number; fileCount: number;
}

function databasePath(home: string): string {
  const path = join(normalizeHome(home), "iamceo.db"), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid!()) throw new Error("안전한 기존 DB 파일이 필요합니다");
  return path;
}

export function inspectStorage(home: string): StorageInspection {
  const path = databasePath(home), db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000");
    const scalar = (sql: string) => Object.values(db.query<Record<string, number>, []>(sql).get()!)[0]!;
    const pageSize = scalar("PRAGMA page_size");
    return { schemaVersion: scalar("PRAGMA user_version"), fileBytes: statSync(path).size,
      allocatedBytes: scalar("PRAGMA page_count") * pageSize, freeBytes: scalar("PRAGMA freelist_count") * pageSize,
      receiptCount: scalar("SELECT count(*) AS n FROM agent_operation_receipts"), fileCount: scalar("SELECT count(*) AS n FROM files") };
  } finally { db.close(); }
}

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
type TableShape = { name: string; columns: string[]; order: string }[];

/** 최적화 전 DB 의 표·칸. 뒤 마이그레이션이 더한 표·칸(새 빈 표, 기존 행의 새 null 칸)은 '바뀐 데이터'가 아니므로 이 모양만 대조한다. */
function tableShape(db: Database): TableShape {
  return db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('files','agent_operation_receipts') ORDER BY name").all().map(({ name }) => {
    const info = db.query<{ name: string; pk: number }, []>(`PRAGMA table_info(${quote(name)})`).all();
    const primary = info.filter(c => c.pk).sort((a,b) => a.pk - b.pk);
    return { name, columns: info.map(c => c.name), order: primary.length ? primary.map(c => quote(c.name)).join(",") : "rowid" };
  });
}

/** Compute the expected v55 changes on a read-only connection. TEMP copies have
 * no user triggers, so unintended changes to original fields still fail verification. */
function expectedTableShape(db: Database, version: number): TableShape {
  const shape = tableShape(db);
  const boardCompletionVersion = 55;
  if (version < boardCompletionVersion && shape.some(table => table.name === "task_completion_reviews")) {
    db.exec(`PRAGMA temp_store=MEMORY;
      CREATE TEMP TABLE work AS SELECT * FROM main.work ORDER BY rowid;
      CREATE TEMP TABLE projects AS SELECT * FROM main.projects ORDER BY rowid;`);
    db.exec(MIGRATIONS[boardCompletionVersion - 1]!);
    shape.find(table => table.name === "work")!.columns.push("auto_done_from");
  }
  return shape;
}

function unaffectedContentDigest(db: Database, shape: TableShape): string {
  const hash = createHash("sha256");
  const priorTables = new Set(shape.map(table => table.name));
  for (const { name, columns, order } of shape) {
    hash.update(name + "\n");
    for (const row of db.query<Record<string, unknown>, []>(`SELECT ${columns.map(quote).join(",")} FROM ${quote(name)} ORDER BY ${order}`).iterate()) {
      // New AUTOINCREMENT tables acquire their own counters during migration.
      if (name === "sqlite_sequence" && !priorTables.has(String(row.name))) continue;
      hash.update(canonicalAgentRequest(row) + "\n");
    }
  }
  return hash.digest("hex");
}

function verifyIntegrity(db: Database): void {
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok" || db.query("PRAGMA foreign_key_check").all().length) throw new Error("DB 무결성 검증에 실패했습니다");
}

export function optimizeStorage(home: string, options: { vacuum?: boolean } = {}): { verified: true; before: StorageInspection; after: StorageInspection } {
  databasePath(home); // Refuse missing/foreign paths before the ownership helper can create anything.
  const owner = acquireHomeOwner(home);
  try {
    const path = databasePath(owner.home), before = inspectStorage(owner.home);
    if (before.schemaVersion < 33 || before.schemaVersion > MIGRATIONS.length) throw new Error("이 최적화는 지원하는 v33 이상 DB에서만 실행할 수 있습니다");
    const probe = new Database(path, { readonly: true });
    let original: ReturnType<typeof storageContentDigest>, unaffected: string, shape: TableShape;
    try {
      verifyIntegrity(probe);
      original = storageContentDigest(probe, before.schemaVersion < STORAGE_OPTIMIZATION_VERSION);
      shape = expectedTableShape(probe, before.schemaVersion);
      unaffected = unaffectedContentDigest(probe, shape);
    } finally { probe.close(); }
    const db = openDb(path, { migrationBackup: false });
    try {
      const verify = () => {
        verifyIntegrity(db);
        if (canonicalAgentRequest(storageContentDigest(db)) !== canonicalAgentRequest(original) || unaffectedContentDigest(db, shape) !== unaffected) throw new Error("최적화 전후의 논리 데이터가 다릅니다");
      };
      verify();
      if (options.vacuum) { db.exec("VACUUM"); verify(); }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
    return { verified: true, before, after: inspectStorage(owner.home) };
  } finally { owner.release(); }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), strict: true, options: {
      home: { type: "string" }, inspect: { type: "boolean" }, apply: { type: "boolean" }, vacuum: { type: "boolean" },
    } });
    if (!values.home || Boolean(values.inspect) === Boolean(values.apply) || (values.vacuum && !values.apply)) throw new Error("사용법: bun scripts/optimize-storage.ts --home <기존 홈> --inspect | --apply [--vacuum]");
    console.log(JSON.stringify(values.apply ? optimizeStorage(values.home, { vacuum: values.vacuum }) : inspectStorage(values.home)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "저장 최적화 실패");
    process.exitCode = 1;
  }
}
