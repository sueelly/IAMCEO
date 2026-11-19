import { releaseTestDir, testTempDir } from "./fixtures/test-run-dirs";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Bus } from "../server/bus";
import { openDb } from "../server/db";
import { DeliveryRecovery } from "../server/delivery-recovery";
import { Store } from "../server/store";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function fixture() {
  const root = testTempDir("iamceo-notice-cost-", "/private/tmp");
  const db = openDb(join(root, "test.db")), bus = new Bus(), store = new Store(db, bus);
  const project = store.createProject({ name: "read-only fixture", cwd: root });
  const member = store.createMember({ projectId: project.id, name: "worker", handle: "worker", kind: "worker" });
  const recovery = new DeliveryRecovery({ store, runner: () => { throw new Error("Notice reads must not call a runner"); } });
  let reads = 0;
  const statements: string[] = [];
  const query = db.query.bind(db);
  db.query = ((...args: Parameters<typeof db.query>) => {
    const statement = query(...args);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "get" && key !== "all") return typeof value === "function" ? value.bind(target) : value;
      return (...params: unknown[]) => { reads++; statements.push(String(args[0])); return value.apply(target, params); };
    } });
  }) as typeof db.query;
  cleanups.push(() => { db.close(); releaseTestDir(root); });
  const measure = <T>(read: () => T) => { reads = 0; statements.length = 0; const start = performance.now(); const result = read(); return { result, reads, ms: performance.now() - start }; };
  return { root, db, bus, store, project, member, recovery, measure, statements };
}

test("delivery summaries do not add per-row SQL reads as a queued project grows", () => {
  const f = fixture();
  const seed = (n: number) => f.store.transaction(() => {
    for (let i = 0; i < n; i++) f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "private instruction" });
  });
  seed(40);
  const small = f.measure(() => f.recovery.notices(f.project.id));
  expect(small.result.members[0].undeliveredCount).toBe(40);
  seed(200);
  const large = f.measure(() => f.recovery.notices(f.project.id));
  expect(large.result.members[0].undeliveredCount).toBe(240);
  console.log("DELIVERY_READ_COST", JSON.stringify({ small: { rows: 40, reads: small.reads, ms: small.ms }, large: { rows: 240, reads: large.reads, ms: large.ms } }));
  expect(large.reads).toBeLessThanOrEqual(small.reads + 8);
  expect(large.reads).toBeLessThan(60);
});

test("notice previews, orphan failures, paging and next reads keep current values without writes", () => {
  const f = fixture(), pid = f.project.id, mid = f.member.id;
  const body = "source🙂" + "a".repeat(180);
  const linked = f.store.createMessage({ projectId: pid, targetMemberId: mid, who: "나", mine: true, kind: "나", body, delivery: "failed" });
  const delivery = f.store.enqueue({ projectId: pid, memberId: mid, kind: "user_message", text: body, refType: "message", refId: linked.id });
  f.store.setDeliveryStatus(delivery.id, "failed");
  const orphan = f.store.createMessage({ projectId: pid, targetMemberId: mid, who: "나", mine: true, kind: "나", body: "orphan failure", delivery: "failed" });
  for (let i = 0; i < 520; i++) f.store.createMessage({ projectId: pid, who: "worker", body: "unrelated history", kind: "진행" });
  const decision = f.store.createDecision({ projectId: pid, memberId: mid, who: "worker", title: "decision preview" });
  f.store.enqueue({ projectId: pid, memberId: mid, kind: "answer", text: "private answer", refType: "decision", refId: decision.id });
  const todo = f.store.createTodo({ projectId: pid, memberId: mid, who: "worker", title: "todo preview" });
  f.store.enqueue({ projectId: pid, memberId: mid, kind: "todo_done", text: "private todo", refType: "todo", refId: todo.id });
  const before = f.db.query("SELECT total_changes() AS n").get(); const seq = f.bus.seq;
  const first = f.recovery.memberNotices(mid, { limit: 2 });
  const second = f.recovery.memberNotices(mid, { limit: 2, before: first.nextBefore! });
  const items = [...first.items, ...second.items];
  expect(items).toHaveLength(4); expect(new Set(items.map(i => i.id)).size).toBe(4);
  expect(items.find(i => i.deliveryId === delivery.id)).toMatchObject({ messageId: linked.id, preview: body.slice(0, 157) + "..." });
  expect(items.find(i => i.id === `message:${orphan.id}`)).toMatchObject({ preview: "orphan failure", allowedActions: [] });
  expect(items.map(i => i.preview)).toContain("decision preview"); expect(items.map(i => i.preview)).toContain("todo preview");
  expect(f.db.query("SELECT total_changes() AS n").get()).toEqual(before); expect(f.bus.seq).toBe(seq);
  f.store.setMessageDelivery(orphan.id, "delivered");
  expect(f.recovery.memberNotices(mid, { limit: 100 }).items.map(i => i.id)).not.toContain(`message:${orphan.id}`);
});

test("notice preview lookup seeks referenced messages instead of scanning the message table", () => {
  const f = fixture(), pid = f.project.id;
  const m = f.store.createMessage({ projectId: pid, who: "나", body: "source", mine: true, kind: "나" });
  f.store.enqueue({ projectId: pid, memberId: f.member.id, kind: "user_message", text: "source", refType: "message", refId: m.id });
  const { result } = f.measure(() => f.store.deliveryNoticePreviews(pid));
  expect(result.get(`message:${m.id}`)).toBe("source");
  const statement = f.statements.find(sql => sql.includes("messages s"))!;
  const plan = f.db.query<{ detail: string }, [string, string]>("EXPLAIN QUERY PLAN " + statement).all(pid, "message");
  expect(plan.some(row => /\bSCAN s\b/.test(row.detail))).toBe(false);
});

test("delivery read scope is synchronous, restores after failure and never hides a later update", () => {
  const f = fixture(), pid = f.project.id;
  const d = f.store.enqueue({ projectId: pid, memberId: f.member.id, kind: "instruction", text: "instruction" });
  expect(() => f.store.withDeliveryRead(pid, () => { expect(f.store.requireDelivery(d.id).status).toBe("queued"); throw new Error("fixture failure"); })).toThrow("fixture failure");
  f.store.setDeliveryStatus(d.id, "held");
  expect(f.store.requireDelivery(d.id).status).toBe("held");
  expect(() => f.store.withDeliveryRead(pid, () => Promise.resolve())).toThrow("synchronous");
  expect(() => f.store.withDeliveryRead(pid, () => { f.store.withDeliveryRead(pid, () => Promise.resolve()); })).toThrow("synchronous");
  expect(f.store.requireDelivery(d.id).status).toBe("held");
});

test("수신 직원 조회는 프로젝트·보류 조건을 적용한 첫 전달 순서를 보존한다", () => {
  const f = fixture();
  const other = f.store.createProject({ name: "다른 프로젝트", cwd: f.root });
  const second = f.store.createMember({ projectId: f.project.id, handle: "second", name: "두 번째", kind: "worker" });
  const foreign = f.store.createMember({ projectId: other.id, handle: "third", name: "다른 직원", kind: "worker" });
  const add = (member: typeof f.member) => f.store.enqueue({ projectId: member.projectId, memberId: member.id, kind: "system", text: "본문" }).id;
  f.store.markHeld(add(f.member), "asleep");
  f.store.setDeliveryStatus(add(second), "delivering");
  f.store.markHeld(add(foreign), "runner_disabled");
  f.store.setDeliveryStatus(add(f.member), "held"); // Imported holds can lack a reason.
  f.store.markDelivered(add(foreign));
  add(second);
  expect(f.store.listUndeliveredMemberIds()).toEqual([f.member.id, second.id, foreign.id]);
  expect(f.store.listUndeliveredMemberIds({ projectId: other.id })).toEqual([foreign.id]);
  const read = f.measure(() => f.store.listUndeliveredMemberIds({ skipInactiveHolds: true }));
  expect(read.result).toEqual([second.id, f.member.id]);
  expect(read.reads).toBe(1);
  expect(f.statements[0]).not.toMatch(/SELECT\s+\*|\btext\b/i);
});
