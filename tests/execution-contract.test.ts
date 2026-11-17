import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as harness from "../server/harness.ts";
import { Store } from "../server/store.ts";
import { Bus } from "../server/bus.ts";
import { commitWorkflowAssignment, previewWorkflowAssignment } from "../server/workflow-assignment.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

const COMPLETE = {
  kind: "other" as const, goal: "검토용 인계 문서를 전달한다", scope: "승인된 인계 문서 한 개",
  inputs: ["대표 원문 #request-17", "기존 승인 상태"], outputs: ["docs/handoff.md"],
  constraints: ["기존 승인 대기를 보존한다"], exclusions: ["운영 배포"],
  acceptance: ["인계 문서에서 담당자와 남은 조건을 확인할 수 있다"], checks: [],
};
const AUTHOR = { author: "대표", authorKind: "owner" as const, authorMemberId: null };
function setup() {
  const f = fixture();
  f.store.patchMember(f.worker.id, { statusObservation: { source: "core", observedAt: new Date().toISOString(), freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: null } });
  const task = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: randomUUID(), title: "명시적 인계", origin: "owner" }).task;
  return { ...f, task };
}

test("agent task contracts retain execution fields and immutable revisions after reopening the store", async () => {
  const f = setup();
  const saved = await f.tool(f.lead, "task", { task_id: f.task.id, contract: COMPLETE });
  expect(saved.isError).toBeUndefined();
  const first = f.store.getTaskContract(f.task.id)!;
  expect(first).toMatchObject({ ...COMPLETE, rev: 1, authorKind: "conductor", confirmedAt: null });
  await f.tool(f.lead, "task", { task_id: f.task.id, contract: { ...COMPLETE, outputs: ["docs/handoff-v2.md"], constraints: [], exclusions: [] } });
  const reopened = new Store(f.store.db, new Bus());
  expect(reopened.listTaskContracts(f.task.id)[0]).toEqual(first);
  expect(reopened.getEffectiveContract(f.task.id)).toMatchObject({ rev: 2, outputs: ["docs/handoff-v2.md"], constraints: [], exclusions: [] });
});

test("agent assignment delivers explicit inputs outputs constraints exclusions with the saved revision", async () => {
  const f = setup();
  const result = await f.tool(f.lead, "team_assign", { member: f.worker.handle, text: "승인된 인계를 수행하세요", task_id: f.task.id, contract: COMPLETE });
  expect(result.isError).toBeUndefined();
  const delivered = f.runner.to(f.worker).join("\n");
  for (const value of [...COMPLETE.inputs, ...COMPLETE.outputs, ...COMPLETE.constraints, ...COMPLETE.exclusions, ...COMPLETE.acceptance, COMPLETE.scope]) expect(delivered).toContain(value);
  expect(delivered).toContain("계약 r1");
  expect(f.store.getTaskContract(f.task.id)).toMatchObject(COMPLETE);
});

test("workflow handoff queues the same explicit contract and invalidates review when outputs change", () => {
  const f = setup();
  f.store.saveTaskContract(f.task.id, COMPLETE, AUTHOR);
  const reviewed = previewWorkflowAssignment(f.store, f.project.id, f.task.id, f.worker.id);
  expect(reviewed.contract).toMatchObject({ inputs: COMPLETE.inputs, outputs: COMPLETE.outputs, constraints: COMPLETE.constraints, exclusions: COMPLETE.exclusions });
  const result = commitWorkflowAssignment(f.store, f.project.id, f.task.id, { operationId: randomUUID(), memberId: f.worker.id, revision: reviewed.revision });
  const queued = f.store.requireDelivery(result.deliveryId);
  for (const value of [...COMPLETE.inputs, ...COMPLETE.outputs, ...COMPLETE.constraints, ...COMPLETE.exclusions, ...COMPLETE.acceptance, COMPLETE.scope]) expect(queued.text).toContain(value);
  expect(queued.text).toContain("계약 r1");
  const other = setup();
  other.store.saveTaskContract(other.task.id, COMPLETE, AUTHOR);
  const stale = previewWorkflowAssignment(other.store, other.project.id, other.task.id, other.worker.id);
  other.store.saveTaskContract(other.task.id, { ...COMPLETE, outputs: ["docs/different.md"] }, AUTHOR);
  expect(() => commitWorkflowAssignment(other.store, other.project.id, other.task.id, { operationId: randomUUID(), memberId: other.worker.id, revision: stale.revision })).toThrow("바뀌었습니다");
  expect(other.store.listTaskDeliveries(other.task.id)).toHaveLength(0);
});

test("legacy contracts keep unknown fields and historical completion without authorizing a new workflow assignment", () => {
  const f = setup();
  const legacy = f.store.saveTaskContract(f.task.id, { kind: "other", goal: "옛 계약", acceptance: ["기존 조건"], forbidden: ["배포 금지"] }, AUTHOR);
  expect(legacy).toMatchObject({ inputs: null, outputs: null, constraints: null, exclusions: null, rev: 1, confirmedAt: null });
  const before = f.store.listTaskContracts(f.task.id);
  const p = previewWorkflowAssignment(f.store, f.project.id, f.task.id, f.worker.id);
  expect(p.blockers.join(" ")).toContain("총괄");
  for (const field of ["입력", "산출물", "범위", "제한조건", "제외 범위"]) expect(p.blockers.join(" ")).toContain(field);
  expect(() => commitWorkflowAssignment(f.store, f.project.id, f.task.id, { operationId: randomUUID(), memberId: f.worker.id, revision: p.revision })).toThrow();
  expect(f.store.listTaskContracts(f.task.id)).toEqual(before);
  expect(f.store.listTaskDeliveries(f.task.id)).toHaveLength(0);
  expect(harness.completionGate(legacy, [{ name: "기존 조건 확인", kind: "other", result: "pass", evidence: "보존된 검증", criterion: 1 }])).toEqual([]);
  const text = harness.formatContract(legacy);
  expect(text).toContain("입력: 미정");
  expect(text).toContain("제외 범위: 미정");
  expect(text).toContain("배포 금지");
});

test("execution completeness distinguishes explicit none from missing fields and whitespace", () => {
  expect(typeof harness.missingExecutionContractFields).toBe("function");
  const missing = harness.missingExecutionContractFields;
  expect(missing({ ...COMPLETE, constraints: [], exclusions: [] })).toEqual([]);
  expect(missing({ ...COMPLETE, inputs: [], outputs: [" "], scope: "\n", constraints: undefined, exclusions: undefined })).toEqual(["inputs", "outputs", "scope", "constraints", "exclusions"]);
  expect(missing({ ...COMPLETE, constraints: [" "], exclusions: ["\t"] })).toEqual(["constraints", "exclusions"]);
  expect(missing(null)).toEqual(["goal", "inputs", "outputs", "scope", "constraints", "acceptance", "exclusions"]);
});

test("explicitly empty restrictions remain explicit in contract and workflow handoffs", () => {
  const f = setup();
  const c = f.store.saveTaskContract(f.task.id, { ...COMPLETE, constraints: [], exclusions: [] }, AUTHOR);
  expect(harness.formatContract(c)).toContain("제한조건: 없음");
  expect(harness.formatContract(c)).toContain("제외 범위: 없음");
  const p = previewWorkflowAssignment(f.store, f.project.id, f.task.id, f.worker.id);
  expect(p.blockers).toEqual([]);
  const result = commitWorkflowAssignment(f.store, f.project.id, f.task.id, { operationId: randomUUID(), memberId: f.worker.id, revision: p.revision });
  expect(f.store.requireDelivery(result.deliveryId).text).toContain("제한조건: 없음");
  expect(f.store.requireDelivery(result.deliveryId).text).toContain("제외 범위: 없음");
});

test.each(["inputs", "outputs"])("agent schema rejects explicit empty %s without creating a revision", async field => {
  const f = setup();
  const result = await f.tool(f.lead, "task", { task_id: f.task.id, contract: { ...COMPLETE, [field]: [] } });
  expect(result.isError).toBe(true);
  expect(f.store.getTaskContract(f.task.id)).toBeNull();
});

test("normalization cannot turn blank restrictions into an explicit none declaration", () => {
  const f = setup();
  const { contract } = f.orch.saveTask(f.lead, { taskId: f.task.id, contract: { ...COMPLETE, constraints: ["\u0000"], exclusions: ["\n "] } });
  expect(harness.missingExecutionContractFields(contract)).toEqual(["constraints", "exclusions"]);
});
