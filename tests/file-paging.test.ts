import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { openDb } from "../server/db";
import { Bus } from "../server/bus";
import { ApiError, Store } from "../server/store";

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.db.close(); });
function fixture(count = 45) {
  const db = openDb(":memory:");
  const store = new Store(db, new Bus()); stores.push(store);
  const project = store.createProject({ name: "목록", cwd: "/fixture", runnerEnabled: false });
  const member = store.createMember({ projectId: project.id, name: "담당", handle: "worker", kind: "worker" });
  const firstTask = store.saveTask({ projectId: project.id, title: "첫 업무", who: "대표", memberId: member.id }).task;
  const otherTask = store.saveTask({ projectId: project.id, title: "다른 업무", who: "대표", memberId: member.id }).task;
  const files = Array.from({ length: count }, (_, i) => store.createFile({ projectId: project.id, title: `자료 ${i}`, body: "large-body-".repeat(2000), kind: i % 2 ? "artifact" : "document", taskId: i % 3 ? firstTask.id : otherTask.id }));
  return { store, db, project, firstTask, otherTask, files };
}

describe("bounded file metadata pages", () => {
  test("first 20 omit bodies and traversal returns every file newest first", () => {
    const { store, project, files } = fixture();
    const first = store.listFilePage(project.id);
    expect(first.items).toHaveLength(20);
    expect(first.items[0]!.id).toBe(files[44]!.id);
    expect(first.items.every(f => !("body" in f))).toBe(true);
    expect(JSON.stringify(first).length).toBeLessThan(20_000);
    const seen = [...first.items]; let page = first;
    while (page.hasMore) { page = store.listFilePage(project.id, { cursor: page.nextCursor! }); seen.push(...page.items); }
    expect(seen.map(f => f.id)).toEqual(files.toReversed().map(f => f.id));
    expect(page.nextCursor).toBeNull();
    expect(first.counts).toEqual({ document: 23, artifact: 22 });
    expect(store.getFile(files[0]!.id)!.body).toStartWith("large-body-");
  });

  test("task and kind filters apply before paging and counts span the whole task", () => {
    const { store, project, firstTask, otherTask } = fixture();
    const page = store.listFilePage(project.id, { taskId: firstTask.id, kind: "document", limit: 3 });
    expect(page.items.map(f => f.title)).toEqual(["자료 44", "자료 40", "자료 38"]);
    expect(page.counts).toEqual({ document: 15, artifact: 15 });
    expect(() => store.listFilePage(project.id, { taskId: otherTask.id, kind: "document", cursor: page.nextCursor! })).toThrow(ApiError);
    expect(() => store.listFilePage(project.id, { taskId: firstTask.id, cursor: page.nextCursor! })).toThrow(ApiError);
    expect(store.listFilePage(project.id, { taskId: "missing" }).items).toEqual([]);
    for (const options of [{ limit: 0 }, { limit: 101 }, { cursor: "not-json" }, { taskId: "" }, { kind: "wrong" }]) {
      expect(() => store.listFilePage(project.id, options as never)).toThrow(ApiError);
    }
  });

  test("ties, deleted boundary and new tail cannot duplicate or skip old rows", () => {
    const { store, project, files } = fixture(8);
    store.db.exec("UPDATE files SET sort_order = 1");
    const all = store.db.query<{ id: string }, [string]>("SELECT id FROM files WHERE project_id = ? ORDER BY sort_order DESC, id COLLATE BINARY DESC").all(project.id).map(f => f.id);
    const first = store.listFilePage(project.id, { limit: 3 });
    store.db.query("DELETE FROM files WHERE id = ?").run(first.items.at(-1)!.id);
    store.createFile({ projectId: project.id, title: "새 자료", body: "new" });
    const rest = store.listFilePage(project.id, { limit: 20, cursor: first.nextCursor! });
    expect([...first.items, ...rest.items].map(f => f.id)).toEqual(all);
    expect(new Set([...first.items, ...rest.items].map(f => f.id)).size).toBe(files.length);
  });

  test("legacy inferred kinds still filter correctly without transferring body", () => {
    const { store, project } = fixture(0);
    const f = store.createFile({ projectId: project.id, title: "예전 문서", body: "legacy" });
    store.db.query("UPDATE files SET kind = NULL WHERE id = ?").run(f.id);
    expect(store.listFilePage(project.id, { kind: "document" }).items.map(f => f.id)).toEqual([f.id]);
    expect(store.listFilePage(project.id, { kind: "file" }).items).toEqual([]);
  });

  test("compact state excludes bulk history/body while legacy state stays complete", () => {
    const { store, project } = fixture();
    for (let i = 0; i < 120; i++) store.createMessage({ projectId: project.id, kind: "진행", body: `글 ${i}` });
    const compact = store.projectState(project.id, { compact: true });
    expect(compact.messages).toEqual([]);
    expect(compact.files).toHaveLength(20);
    expect(compact.files.every(f => f.body === "")).toBe(true);
    expect(JSON.stringify(compact).length).toBeLessThan(40_000);
    expect(store.projectState(project.id).files).toHaveLength(45);
    expect(store.projectState(project.id).messages).toHaveLength(120);
  });

  test("task paging seeks the covering index without a temporary sort", () => {
    const { store, db, project, firstTask } = fixture();
    const spy = spyOn(db, "query");
    store.listFilePage(project.id, { taskId: firstTask.id, limit: 3 });
    const sql = spy.mock.calls.map(args => args[0]).find(s => s.includes("ORDER BY") && s.includes("FROM files"))!;
    spy.mockRestore();
    expect(sql).toBeDefined();
    const plan = store.db.query<{ detail: string }, [string, string, number]>(`EXPLAIN QUERY PLAN ${sql}`).all(project.id, firstTask.id, 4).map(r => r.detail).join("\n");
    expect(plan).toContain("files_page_task");
    expect(plan).not.toContain("USE TEMP B-TREE");
  });
});
