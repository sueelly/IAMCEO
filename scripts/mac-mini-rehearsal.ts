/** Convert a verified INITIAL export to the existing backup format, then clone-restore offline.
 * This command never serves HTTP, creates runners, reconciles or resumes outbound work.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { backupFile, checkBackupDatabase, verifyBackup, type BackupManifest } from "../server/backup.ts";
import { VERSION } from "../server/config.ts";
import { restoreBackup, verifyRestoredHome } from "../server/restore.ts";

export function rehearse(root: string, privateRoot: string) {
  root = resolve(root); privateRoot = resolve(privateRoot);
  const readyPath = join(root, "SOURCE_EXPORT_READY.json");
  const ready = JSON.parse(readFileSync(readyPath, "utf8"));
  if (ready.kind !== "initial-preparation-only" || ready.cutover_allowed !== false) throw new Error("Preparation-only export required");
  const incoming = join(root, "incoming", "initial");
  for (const [name, expected] of Object.entries(ready.files) as [string, { bytes: number; sha256: string }][]) {
    if (name !== name.split("/").at(-1) || name === "." || name === "..") throw new Error("Invalid export filename");
    const actual = backupFile(join(incoming, name));
    if (actual.size !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error("Export digest mismatch");
  }
  const sourceHome = JSON.parse(readFileSync(join(root, "source-manifest.json"), "utf8")).source_data_root as string;
  const raw = join(privateRoot, "source-runtime");
  const snapshots = join(privateRoot, "snapshots");
  mkdirSync(snapshots, { recursive: true, mode: 0o700 });
  const now = new Date(); const id = `snapshot-${now.getTime()}-${randomUUID()}`;
  const snapshot = join(snapshots, id);
  mkdirSync(snapshot, { mode: 0o700 }); mkdirSync(join(snapshot, "attachments"), { mode: 0o700 });
  backupFile(join(incoming, "iamceo.db"), join(snapshot, "iamceo.db"));
  // The exported backup retains WAL mode. Normalize only this private copy,
  // so read-only verification never depends on source-device WAL/SHM files.
  const db = new Database(join(snapshot, "iamceo.db"), { readwrite: true });
  db.exec("PRAGMA journal_mode=DELETE");
  const database = { path: "iamceo.db" as const, ...backupFile(join(snapshot, "iamceo.db")) };
  let manifest: BackupManifest;
  try {
    const schemaVersion = checkBackupDatabase(db);
    const attachments: BackupManifest["attachments"] = [];
    const rows = db.query<{ id: string; path: string; size: number }, []>("SELECT id,path,size FROM attachments ORDER BY id COLLATE BINARY").all();
    for (const [index, row] of rows.entries()) {
      const tail = relative(join(sourceHome, "uploads"), row.path);
      if (!tail || tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) throw new Error("Attachment escapes source uploads");
      const path = `attachments/${index}.bin`;
      const copied = backupFile(join(raw, "uploads", tail), join(snapshot, path));
      if (copied.size !== row.size) throw new Error("Attachment size mismatch");
      attachments.push({ id: row.id, sourcePath: row.path, path, ...copied });
    }
    const configs: BackupManifest["configs"] = [{ path: "config.json", ...backupFile(join(raw, "config.json"), join(snapshot, "config.json")) }];
    manifest = { format: 1, id, createdAt: now.toISOString(), applicationVersion: VERSION, sourceHome,
      sourceHomeAliases: [], schemaVersion, database, configs, attachments,
      externalSecrets: { apnsP8: "separate_backup_required_not_included" },
      verification: { integrity: "ok", foreignKeys: "ok", attachments: "ok" } };
  } finally { db.close(); }
  // SQLite can leave a zero-length WAL or stale SHM after changing journal mode.
  // This newly created copy is closed and has no other users.
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = join(snapshot, "iamceo.db" + suffix);
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  manifest.database = { path: "iamceo.db", ...backupFile(join(snapshot, "iamceo.db")) };
  writeFileSync(join(snapshot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  verifyBackup(snapshot);
  const destination = join(privateRoot, "restored-" + id);
  restoreBackup({ snapshotDir: snapshot, destinationHome: destination, mode: "clone" });
  verifyRestoredHome(destination);
  const copy = new Database(join(destination, "iamceo.db"), { readonly: true });
  let counts: Record<string, number>, fences: { outboundEnabled: boolean; reconciliationRequired: boolean };
  try {
    counts = Object.fromEntries(Object.keys(ready.db_counts).map(table => {
      if (!["projects", "members", "messages", "tasks", "decisions", "files", "attachments"].includes(table)) throw new Error("Unexpected count table");
      const count = copy.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!.n;
      if (count !== ready.db_counts[table]) throw new Error("Row count mismatch: " + table);
      return [table, count];
    }));
    fences = JSON.parse(copy.query<{ value: string }, []>("SELECT value FROM settings WHERE key='restoreReconciliation'").get()!.value);
    if (fences.outboundEnabled || !fences.reconciliationRequired) throw new Error("Outbound fence missing");
    if (copy.query("SELECT 1 FROM projects WHERE runner_enabled != 0 LIMIT 1").get()) throw new Error("Runner enabled in rehearsal");
    if (existsSync(join(destination, "run"))) throw new Error("Runtime socket directory was copied");
  } finally { copy.close(); }
  const receipt = { kind: "target-offline-rehearsal", at: new Date().toISOString(), source_receipt_sha256: backupFile(readyPath).sha256,
    target_rehearsal_snapshot_id: id, source_final_snapshot_id: null, snapshot, restored_home: destination,
    verified_attachments: manifest.attachments.length, counts, outbound_enabled: false, reconciliation_required: true,
    workers_started: 0, operational_cutover: false };
  const receiptPath = join(root, "RESTORE_REHEARSAL_VERIFIED.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }); chmodSync(receiptPath, 0o600);
  return receipt;
}

if (import.meta.main) {
  const [root, privateRoot] = process.argv.slice(2);
  if (!root || !privateRoot) throw new Error("Usage: bun scripts/mac-mini-rehearsal.ts MIGRATION_ROOT PRIVATE_REHEARSAL_ROOT");
  const result = rehearse(root, privateRoot);
  console.log(JSON.stringify({ receipt: "RESTORE_REHEARSAL_VERIFIED.json", attachments: result.verified_attachments,
    counts: result.counts, outbound_enabled: false, workers_started: 0 }));
}
