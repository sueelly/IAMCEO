import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../../server/db.ts";

/** The historical on-disk rows must be writable before the current Store can open them. */
export function legacyStorage(path: string, cwd: string, version: 33 | 34 | 54) {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys=ON");
  for (let v = 0; v < version; v++) db.exec(MIGRATIONS[v]!);
  db.exec(`PRAGMA user_version=${version}`);
  const at = "2026-11-17T00:00:00.000Z", projectId = "p_legacy", memberId = "m_legacy";
  db.query("INSERT INTO projects (id,name,cwd,runner_enabled,created_at,updated_at) VALUES (?,'기존 자료',?,1,?,?)")
    .run(projectId, cwd, at, at);
  db.query(`INSERT INTO members (id,project_id,handle,name,kind,origin,status,cwd,token,created_at,updated_at)
    VALUES (?,?,'worker','작업자','worker','manual','idle',?,'fixture-token',?,?)`).run(memberId, projectId, cwd, at, at);
  return { db, path, projectId, memberId, at };
}
