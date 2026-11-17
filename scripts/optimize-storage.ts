import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openDb, MIGRATIONS } from "../server/db.ts";
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

function unaffectedContentDigest(db: Database): string {
  const hash = createHash("sha256"), quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('files','agent_operation_receipts') ORDER BY name").all();
  for (const { name } of tables) {
    hash.update(name + "\n");
    const primary = db.query<{ name: string; pk: number }, []>(`PRAGMA table_info(${quote(name)})`).all().filter(c => c.pk).sort((a,b) => a.pk - b.pk);
    const order = primary.length ? primary.map(c => quote(c.name)).join(",") : "rowid";
    for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM ${quote(name)} ORDER BY ${order}`).iterate()) hash.update(canonicalAgentRequest(row) + "\n");
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
    let original: ReturnType<typeof storageContentDigest>, unaffected: string;
    try {
      verifyIntegrity(probe);
      original = storageContentDigest(probe, before.schemaVersion === 33);
      unaffected = unaffectedContentDigest(probe);
    } finally { probe.close(); }
    const db = openDb(path, { migrationBackup: false });
    try {
      const verify = () => {
        verifyIntegrity(db);
        if (canonicalAgentRequest(storageContentDigest(db)) !== canonicalAgentRequest(original) || unaffectedContentDigest(db) !== unaffected) throw new Error("최적화 전후의 논리 데이터가 다릅니다");
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
