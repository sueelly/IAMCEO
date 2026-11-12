// 웹 작업 고르기: 보낸 순간의 작업이 시도에 고정되고(재시도·새로고침 뒤에도), 보낸 뒤에도 고른 작업이 남는다.
import { describe, expect, test } from "bun:test";
import type { Message, Task } from "../shared/types";
import { SubmissionManager, type MessageAttempt } from "../web/src/lib/submissions";
import { taskTarget, visibleTasks } from "../web/src/lib/tasks";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const missing = () => { throw Object.assign(new Error("없음"), { status: 404 }); };
function manager(storage: MemoryStorage, send: (a: MessageAttempt) => Promise<Message | null>, lookup: (id: string) => Promise<Message> = async () => missing()) {
  let n = 0;
  return new SubmissionManager({ storage, host: "http://host:7881", session: () => "s", newId: () => `m${++n}`, send, lookup, accepted: () => {} });
}
const task = (id: string, memberId: string | null, createdAt: string): Task => ({ id, projectId: "p1", memberId, who: memberId ?? "", title: id, branch: null, worktree: null, createdAt, updatedAt: createdAt });

describe("작업 고르기", () => {
  test("보낸 순간의 작업이 시도에 고정되고, 그 뒤 다른 작업을 골라도 재시도·새로고침한 시도는 원래 작업이다", async () => {
    const storage = new MemoryStorage();
    const sent: MessageAttempt[] = [];
    const m = manager(storage, async (a) => { sent.push(a); return null; });
    m.patchDraft("p1", (d) => ({ ...d, text: "A 작업 글", targetId: "w1", taskId: "tk_a" }));
    await m.submit("p1", m.snapshot("p1").draft, { text: "A 작업 글", targetMemberId: "w1", attachmentIds: [], taskId: "tk_a" }, { targetName: "결제" });
    // 보낸 뒤에도 고른 작업과 대상이 남는다
    expect(m.snapshot("p1").draft).toMatchObject({ text: "", targetId: "w1", taskId: "tk_a" });
    // 대표가 B 작업으로 옮긴다
    m.patchDraft("p1", (d) => ({ ...d, targetId: "w2", taskId: "tk_b" }));
    await m.retry("p1", "m1");
    expect(sent.map((a) => a.payload.taskId)).toEqual(["tk_a", "tk_a"]);
    expect(sent.map((a) => a.payload.targetMemberId)).toEqual(["w1", "w1"]);
    // 새로고침(새 관리자, 같은 저장소): 시도는 A, 입력칸은 B 그대로
    const reloaded = manager(storage, async (a) => { sent.push(a); return null; });
    const snap = reloaded.snapshot("p1");
    expect(snap.attempts.map((a) => a.payload.taskId)).toEqual(["tk_a"]);
    expect(snap.draft.taskId).toBe("tk_b");
    await reloaded.retry("p1", "m1");
    expect(sent.at(-1)!.payload).toMatchObject({ id: "m1", taskId: "tk_a", targetMemberId: "w1" });
  });

  test("전체에서 보내면 예전처럼 대상이 비워지고 작업은 없다", async () => {
    const m = manager(new MemoryStorage(), async () => null);
    m.patchDraft("p1", (d) => ({ ...d, text: "전체 글", targetId: "w1" }));
    await m.submit("p1", m.snapshot("p1").draft, { text: "전체 글", targetMemberId: "w1", attachmentIds: [], taskId: null }, {});
    expect(m.snapshot("p1").draft.targetId).toBeNull();
    expect(m.snapshot("p1").draft.taskId ?? null).toBeNull();
    expect(m.snapshot("p1").attempts[0]!.payload.taskId).toBeNull();
  });

  test("작업 칩은 최신순이고, 직원을 고르면 그 직원의 작업만, 작업을 고르면 받는 사람은 등록한 직원이다", () => {
    const tasks = [task("old", "w1", "2026-11-01T00:00:00Z"), task("new", "w2", "2026-11-03T00:00:00Z"), task("mid", "w1", "2026-11-02T00:00:00Z"), task("lead", "c1", "2026-11-04T00:00:00Z")];
    expect(visibleTasks(tasks, null).map((t) => t.id)).toEqual(["lead", "new", "mid", "old"]);
    expect(visibleTasks(tasks, "w1").map((t) => t.id)).toEqual(["mid", "old"]);
    const workers = [{ id: "w1", name: "가" }, { id: "w2", name: "나" }];
    expect(taskTarget(tasks[0]!, workers)).toBe("w1");
    // 총괄이 등록했거나 닫힌 직원의 작업이면 기본 대상(총괄)
    expect(taskTarget(tasks[3]!, workers)).toBeNull();
    expect(taskTarget(task("gone", "w9", "2026-11-05T00:00:00Z"), workers)).toBeNull();
  });
});
