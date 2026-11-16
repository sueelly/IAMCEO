import { afterEach, expect, test } from "bun:test";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { Bus } from "../server/bus.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function fixture() {
  const db = openDb(":memory:");
  cleanups.push(() => db.close());
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "자료", cwd: "/private/tmp" });
  let bodyReads = 0;
  let metadataSql = "";
  const query = db.query.bind(db);
  db.query = ((sql: string) => {
    if (/\bFROM files\b/i.test(sql) && /\bbody\b|SELECT \*/i.test(sql)) bodyReads++;
    if (/^SELECT /i.test(sql) && /\bFROM files\b/i.test(sql) && !/\bbody\b|SELECT \*/i.test(sql)) metadataSql = sql;
    return query(sql);
  }) as typeof db.query;
  return { db, store, project, bodyReads: () => bodyReads,
    metadataPlan: () => query("EXPLAIN QUERY PLAN " + metadataSql).all(project.id).map(row => (row as { detail: string }).detail).join("\n") };
}

test("file metadata uses a covering index without traversing content overflow pages and retains rowid ties", () => {
  const f = fixture();
  const first = f.store.createFile({ projectId: f.project.id, title: "먼저", body: "본문", html: "큰 원문", kind: "artifact" });
  const second = f.store.createFile({ projectId: f.project.id, title: "나중", body: "다음 본문" });
  f.db.query("UPDATE files SET sort_order = 0 WHERE project_id = ?").run(f.project.id);
  expect(f.store.listFiles(f.project.id).map(file => file.id)).toEqual([second.id, first.id]);
  expect(f.metadataPlan()).toContain("USING COVERING INDEX");
});

test("repeated file snapshots reuse immutable bodies across unrelated member updates", () => {
  const f = fixture();
  const file = f.store.createFile({ projectId: f.project.id, title: "원기록", body: "기록".repeat(100_000), kind: "document" });
  const first = f.store.listFiles(f.project.id);
  const reads = f.bodyReads();
  const worker = f.store.createMember({ projectId: f.project.id, name: "직원", handle: "worker", kind: "worker" });
  f.store.patchMember(worker.id, { status: "working" });
  expect(f.store.listFiles(f.project.id)).toEqual(first);
  expect(first[0]?.body).toBe(file.body);
  expect(f.bodyReads()).toBe(reads);
});

test("cached bodies keep fresh metadata, new files, project isolation and caller edits", () => {
  const f = fixture();
  const old = f.store.createFile({ projectId: f.project.id, title: "기존", body: "원문" });
  const initial = f.store.listFiles(f.project.id);
  initial[0]!.body = "호출자 수정";
  f.store.restoreTimes("files", old.id, { createdAt: "2001-01-01T00:00:00.000Z" });
  const other = f.store.createProject({ name: "다른 프로젝트", cwd: "/private/tmp" });
  f.store.createFile({ projectId: other.id, title: "다른 자료", body: "다른 원문" });
  const added = f.store.createFile({ projectId: f.project.id, title: "새 자료", body: "새 원문" });
  const files = f.store.listFiles(f.project.id);
  expect(files.map(file => file.id)).toEqual([added.id, old.id]);
  expect(files[1]).toMatchObject({ body: "원문", createdAt: "2001-01-01T00:00:00.000Z" });
  expect(f.store.listFiles(other.id).map(file => file.body)).toEqual(["다른 원문"]);
});

test("body cache evicts old large entries instead of growing with every project", () => {
  const f = fixture();
  const body = "a".repeat(1024 * 1024);
  f.store.createFile({ projectId: f.project.id, title: "첫 자료", body });
  f.store.listFiles(f.project.id);
  const warm = f.bodyReads();
  f.store.listFiles(f.project.id);
  expect(f.bodyReads()).toBe(warm);
  for (let i = 0; i < 8; i++) {
    const project = f.store.createProject({ name: `프로젝트 ${i}`, cwd: "/private/tmp" });
    f.store.createFile({ projectId: project.id, title: "큰 자료", body });
    f.store.listFiles(project.id);
  }
  const beforeReload = f.bodyReads();
  expect(f.store.listFiles(f.project.id)[0]?.body).toBe(body);
  expect(f.bodyReads()).toBe(beforeReload + 1);
});
