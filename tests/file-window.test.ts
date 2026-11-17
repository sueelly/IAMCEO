import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus";
import { openDb } from "../server/db";
import { Store } from "../server/store";
import { reconcileFileWindow } from "../web/src/lib/file-window";
import type { FilePage } from "../shared/types";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });
function fixture() {
  const store = new Store(openDb(":memory:"), new Bus()); stores.push(store);
  const project = store.createProject({ name: "Exhausted file window", cwd: "/isolated", runnerEnabled: false });
  const member = store.createMember({ projectId: project.id, name: "Fixture", handle: "fixture", kind: "worker" });
  const task = (title: string) => store.saveTask({ projectId: project.id, memberId: member.id, who: "Fixture", title }).task;
  const target = task("Target"), source = task("Source");
  const old = store.createFile({ projectId: project.id, taskId: source.id, title: "Moved old file", body: "immutable body", kind: "document" });
  for (let i = 0; i < 40; i++) store.createFile({ projectId: project.id, taskId: target.id, title: `Target ${i}`, body: "body", kind: "document" });
  const page = (cursor?: string) => store.listFilePage(project.id, { taskId: target.id, limit: 20, cursor });
  const first = page(), second = page(first.nextCursor!);
  const complete: FilePage = { ...second, items: [...first.items, ...second.items] };
  const move = () => store.moveRecordTask({ projectId: project.id, refType: "file", refId: old.id, from: source.id, to: target.id, basis: "classify", actor: "Fixture" });
  const recent = () => store.listFilePage(project.id, { limit: 20 }).items;
  return { store, project, target, old, first, complete, page, move, recent, scope: { taskId: target.id, kind: null } };
}

test("an exhausted forty-row window discovers an older task move omitted by the compact preview", async () => {
  const f = fixture(); expect(f.complete.items).toHaveLength(40); expect(f.complete.hasMore).toBe(false);
  f.move(); const first = f.page(); const recent = f.recent();
  expect(recent.some(x => x.id === f.old.id)).toBe(false);
  const reads: string[] = [];
  const result = await reconcileFileWindow(f.complete, first, null, recent, f.scope, async cursor => { reads.push(cursor!); return f.page(cursor!); });
  expect(result.items).toHaveLength(41);
  expect(result.items.filter(x => x.id === f.old.id)).toHaveLength(1);
  expect(result.items.find(x => x.id === f.old.id)?.taskId).toBe(f.target.id);
  expect(result.hasMore).toBe(false); expect(result.nextCursor).toBeNull();
  expect(new Set(result.items.map(x => x.id)).size).toBe(41);
  expect(new Set(reads).size).toBe(reads.length);
});

test("a partial window keeps its continuation instead of reading unseen old rows on refresh", async () => {
  const f = fixture(); f.move(); let reads = 0;
  const result = await reconcileFileWindow(f.first, f.page(), null, f.recent(), f.scope, async cursor => { reads++; return f.page(cursor!); });
  expect(result.items).toHaveLength(20); expect(result.hasMore).toBe(true); expect(result.nextCursor).toBeTruthy(); expect(reads).toBe(0);
});

test("an unchanged exhausted window retains its forty rows without redundant continuation reads", async () => {
  const f = fixture(); let reads = 0;
  const result = await reconcileFileWindow(f.complete, f.page(), null, f.recent(), f.scope, async cursor => { reads++; return f.page(cursor!); });
  expect(result.items.map(x => x.id)).toEqual(f.complete.items.map(x => x.id));
  expect(result.hasMore).toBe(false); expect(reads).toBe(0);
});

test("a repeated cursor during completion fails rather than accepting an incomplete list", async () => {
  const f = fixture(); f.move(); const first = f.page();
  await expect(reconcileFileWindow(f.complete, first, null, f.recent(), f.scope, async () => first)).rejects.toThrow("자료 목록의 위치 정보가 반복되었습니다");
});
