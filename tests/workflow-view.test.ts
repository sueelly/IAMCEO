import { expect, test } from "bun:test";
import type { ProjectWorkflow, WorkflowNode } from "../shared/workflow.ts";
import { workflowBucket, workflowCategory, workflowFocus, workflowNodeAt, workflowSummary } from "../shared/workflow-view.ts";

const node = (id: string, patch: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, taskId: id, memberId: "worker", order: 0, state: "waiting", label: "선행 업무 대기", current: false, reason: null, action: null, assignedAt: "2026-11-18T00:00:00Z", observedAt: null, lastActivity: null, counts: { queued: 0, held: 0, notices: 0 }, ...patch });

test("unfinished history and review stay in now; only verified completion is past", () => {
  expect(workflowBucket(node("old", { historical: true, state: "review", label: "결과 확인 필요" }))).toBe("now");
  expect(workflowBucket(node("fix", { historical: true, state: "blocked" }))).toBe("now");
  expect(workflowBucket(node("review", { state: "review" }))).toBe("now");
  expect(workflowBucket(node("current", { current: true }))).toBe("now");
  expect(workflowBucket(node("next"))).toBe("next");
  expect(workflowBucket(node("done", { state: "done" }))).toBe("done");
  expect(workflowBucket(node("free", { memberId: null }))).toBe("unassigned");
});

test("counts distinguish an owner response, team processing, an automatic wait and historical participation", () => {
  const counts = workflowSummary([node("a", { state: "running" }), node("b", { taskId: "a", state: "blocked", ownerActionRequired: true }),
    node("done", { state: "done" }), node("queue", { current: true, state: "queued" }), node("wait", { current: true }),
    node("free", { memberId: null }), node("review", { state: "review" }), node("old", { historical: true, state: "review" }),
    node("check", { state: "blocked", label: "총괄 점검", ownerActionRequired: false }), node("stale", { state: "unknown" }),
    node("owner", { state: "blocked", memberId: null, ownerActionRequired: true })]);
  expect(counts).toEqual({ all: 10, action: 2, running: 0, next: 2, review: 3, history: 1, done: 1, unassigned: 1 });
  expect(workflowCategory(node("completed-with-open-inbox-item", { historical: true, memberId: null, state: "done", ownerActionRequired: true }))).toBe("action");
  expect(workflowBucket(node("free-with-open-inbox-item", { memberId: null, ownerActionRequired: true }))).toBe("now");
});

test("legacy workflows distinguish direct decisions and actual terminal prompts from propagated gates and internal recovery", () => {
  const inbox = { label: "결재함 열기", tab: "inbox" as const, sub: null };
  const team = { label: "직원 확인", tab: "team" as const, sub: "worker" };
  const base = { state: "blocked" as const, label: "대표 확인", action: inbox };
  expect(workflowCategory(node("self", base))).toBe("action");
  expect(workflowCategory(node("inherited", { ...base, reason: "‘다른 업무’에서 대표의 결정을 기다립니다" }))).toBe("review");
  expect(workflowCategory(node("overridden", { ...base, ownerActionRequired: false }))).toBe("review");
  expect(workflowCategory(node("true-prompt", { ...base, current: true, action: team, label: "승인 응답 대기" }))).toBe("action");
  expect(workflowCategory(node("other-prompt", { ...base, action: team, label: "승인 창" }))).toBe("review");
  expect(workflowCategory(node("login", { ...base, current: true, action: team, label: "로그인 필요" }))).toBe("action");
  expect(workflowCategory(node("historical", { historical: true, state: "review", action: team }))).toBe("history");
  const inputBlock = { deliveryId: "old", phase: "needs_owner", reason: "duplicate_draft", holdReason: null, nextCheckAt: null, lastCheckedAt: null };
  expect(workflowCategory(node("draft", { state: "blocked", inputBlock }))).toBe("action");
  expect(workflowCategory(node("auto", { state: "blocked", inputBlock: { ...inputBlock, phase: "checking" } }))).toBe("review");
  expect(workflowCategory(node("manual", { state: "blocked", inputBlock: { ...inputBlock, phase: "resolved", reason: "not_received", retryReason: "rejected_limit" } }))).toBe("action");
  expect(workflowCategory(node("stopped", { state: "blocked", inputBlock: { ...inputBlock, phase: "stopped", retryReason: "rejected_limit" } }))).toBe("review");
});

test("an expired runtime observation stays visible to the team and preserves a separate inbox action", () => {
  const now = Date.parse("2026-11-18T00:02:00Z");
  const running = node("late", { state: "running", observedAt: "2026-11-18T00:00:00Z" });
  expect(workflowCategory(workflowNodeAt(running, now))).toBe("review");
  expect(workflowNodeAt(running, now).label).toBe("실행 상태 미확인");
  expect(workflowNodeAt(running, now).action?.tab).toBe("team");
  const owner = { ...running, ownerActionRequired: true, action: { label: "결재함 열기", tab: "inbox" as const, sub: null } };
  expect(workflowNodeAt(owner, now).action).toEqual(owner.action);
  expect(workflowCategory(workflowNodeAt(owner, now))).toBe("action");
  expect(workflowNodeAt(running, now - 60_000)).toBe(running);
});

test("focus includes same task occurrences and their direct links, not the entire employee history", () => {
  const flow: ProjectWorkflow = { nodes: [node("a"), node("a2", { taskId: "a" }), node("parent"), node("child"), node("next"), node("far")], edges: [
    { id: "1", from: "parent", to: "a", kind: "derived" }, { id: "2", from: "a2", to: "child", kind: "derived" },
    { id: "3", from: "a", to: "next", kind: "sequence" }, { id: "4", from: "next", to: "far", kind: "sequence" },
  ] };
  expect([...workflowFocus(flow, "a", "direct")].sort()).toEqual(["a", "a2", "child", "next", "parent"]);
  flow.edges.push({ id: "cycle", from: "child", to: "parent", kind: "derived" });
  expect([...workflowFocus(flow, "a", "family")].sort()).toEqual(["a", "a2", "child", "next", "parent"]);
  expect(workflowFocus(flow, "missing", "family").size).toBe(0);
});
