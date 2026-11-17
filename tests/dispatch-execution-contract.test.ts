import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Runner, RunnerMember } from "../server/runner/types.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

const contract = { kind: "other" as const, goal: "승인된 문서를 작성한다", inputs: ["요청 원문"], outputs: ["검증한 문서"],
  scope: "문서 작성", constraints: ["원본 자료 보존"], exclusions: ["배포"], acceptance: ["검증한 문서가 있다"], checks: [] };

async function uncertainAssignment(inherited = false) {
  const f = fixture();
  const parent = f.orch.saveTask(f.lead, { title: "문서 작업", contract }).task;
  const task = inherited ? f.orch.saveTask(f.lead, { title: "하위 문서", parentTaskId: parent.id }).task : parent;
  f.runner.send = async () => ({ ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" });
  const assigned = await f.orch.assign(f.project.id, f.worker.handle, { taskId: task.id, text: "승인된 문서를 작성하세요" }, f.lead);
  const delivery = f.store.requireDelivery(assigned.delivery.id);
  const dispatch = f.store.listDeliveryDispatches(delivery.id).at(-1)!;
  let repairs = 0;
  const runner: Runner = f.runner;
  runner.repairDelivery = async () => { repairs++; return { ok: true, started: false, turn: 0 }; };
  const member: RunnerMember = { ...f.worker, model: null, effort: null, subagentModel: null, permissionMode: "default", sessionGeneration: 0 };
  const request = { action: "resend" as const, dispatchId: dispatch.dispatchId, expectedRecoveryVersion: f.store.getDeliveryRecovery(delivery.id)!.version,
    expectedSessionGeneration: 0, expectedSessionId: f.worker.sessionId, expectedTerminalId: f.worker.paneId!, expectedInputEpoch: 0 };
  return { ...f, parent, task, delivery, dispatch, member, request, get repairs() { return repairs; } };
}

test("actual wire persists current contract separately from the unchanged original source revision", async () => {
  const f = await uncertainAssignment();
  expect(f.dispatch.baseline.executionContracts).toEqual([{ taskId: f.task.id, contractTaskId: f.task.id, rev: 1, context: expect.stringContaining("검증한 문서가 있다") }]);
  expect(f.dispatch.wireText).toContain("업무 계약 r1");
  expect(f.dispatch.items[0]!.sourceRevision).toBe(createHash("sha256").update(JSON.stringify({ text: f.delivery.text, memberId: f.worker.id })).digest("hex"));
  expect(createHash("sha256").update(f.dispatch.wireText).digest("hex")).toBe(f.dispatch.wireSha256);
  expect(f.store.requireDelivery(f.delivery.id).text).toBe(f.delivery.text);
});

test("a stale contract still allows receipt inspection to reconcile the original input", async () => {
  const f = await uncertainAssignment();
  f.orch.saveTask(f.lead, { taskId: f.task.id, contract: { ...contract, goal: "새 요청을 조사한다" } });
  const runner: Runner = f.runner;
  runner.inspectDelivery = async () => ({ finding: "received", receivedDeliveryIds: [f.delivery.id], snapshot: null, quiescence: "unresolved",
    evidence: [{ source: "transport", verdict: "present", location: "received_input", code: "verified_receipt", complete: true, checkedAt: new Date().toISOString() }] });
  await f.orch.deliveryRecovery.tick();
  expect(f.store.requireDelivery(f.delivery.id).status).toBe("delivered");
  expect(f.store.getDeliveryRecovery(f.delivery.id)?.phase).toBe("resolved");
  expect(f.repairs).toBe(0);
  expect(f.store.getDispatch(f.dispatch.dispatchId)?.wireText).toBe(f.dispatch.wireText);
});

test("an unchanged persisted execution contract permits the existing recovery write", async () => {
  const f = await uncertainAssignment();
  const result = await f.orch.recoveryRunner(f.worker)!.repairDelivery!(f.member, f.request);
  expect(result.ok).toBe(true);
  expect(f.repairs).toBe(1);
  expect(f.store.requireDelivery(f.delivery.id).status).toBe("delivered");
});

test("a contract change during recovery preflight preserves the original uncertain write", async () => {
  const f = await uncertainAssignment();
  const runner: Runner = f.runner;
  let writes = 0;
  runner.repairDelivery = async (_member, _request, options) => {
    f.orch.saveTask(f.lead, { taskId: f.task.id, contract: { ...contract, goal: "검토 범위만 조사한다" } });
    if (options?.beforeWrite?.() === false) return { ok: false, reason: "busy", retryable: false, deliveryEffect: "not_written" };
    writes++;
    return { ok: true, started: false };
  };
  const result = await f.orch.recoveryRunner(f.worker)!.repairDelivery!(f.member, f.request);
  expect(result.ok).toBe(false);
  expect(writes).toBe(0);
  expect(f.store.getDispatch(f.dispatch.dispatchId)?.transportState).toBe("unknown");
  expect(f.store.requireDelivery(f.delivery.id).deliveredAt).toBeNull();
  expect(f.orch.deliveryRecovery.fenced(f.worker.id)).toBe(true);
});

for (const change of ["revision", "inherited_owner", "missing_snapshot"] as const) {
  test(`recovery cannot replay a worker envelope with ${change} contract context`, async () => {
    const f = await uncertainAssignment(change === "inherited_owner");
    if (change === "missing_snapshot") {
      const { executionContracts: _snapshot, ...legacy } = f.dispatch.baseline as typeof f.dispatch.baseline & { executionContracts?: unknown };
      f.store.db.query("UPDATE delivery_dispatches SET baseline_json=? WHERE id=?").run(JSON.stringify(legacy), f.dispatch.dispatchId);
    } else f.orch.saveTask(f.lead, { taskId: f.task.id, contract: { ...contract, goal: "조정된 문서만 작성한다" } });
    const original = f.store.getDispatch(f.dispatch.dispatchId)!;
    const result = await f.orch.recoveryRunner(f.worker)!.repairDelivery!(f.member, f.request);
    expect(result).toMatchObject({ ok: false, deliveryEffect: "not_written" });
    expect(f.repairs).toBe(0);
    expect(f.store.getDispatch(original.dispatchId)).toEqual(original);
    expect(f.store.requireDelivery(f.delivery.id).text).toBe(f.delivery.text);
  });
}
