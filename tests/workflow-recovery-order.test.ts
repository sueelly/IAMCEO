import { expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { DeliveryRecovery } from "../server/delivery-recovery.ts";
import { Store } from "../server/store.ts";
import type { DeliveryInspection, DeliveryProbe, DeliveryRepair, RunnerMember, SendResult } from "../server/runner/types.ts";

// Real recovery/store with an isolated evidence adapter; no provider, server, or live data.
function fixture() {
  const db = openDb(":memory:");
  const store = new Store(db, new Bus());
  const project = store.createProject({ name: "Recovery order", cwd: "/private/tmp/workflow-recovery-test" });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "Worker", kind: "worker", origin: "runner", backend: "core", status: "idle", sessionId: "isolated-session", paneId: "isolated-terminal" });
  const first = store.saveTask({ projectId: project.id, memberId: member.id, who: member.name, title: "First task", branch: "test/first" }).task;
  const second = store.saveTask({ projectId: project.id, memberId: member.id, who: member.name, title: "Second task", branch: "test/second" }).task;
  store.markDelivered(store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "First unfinished work", taskId: first.id }).id);
  const later = store.enqueue({ projectId: project.id, memberId: member.id, kind: "instruction", text: "Later work awaiting receipt", taskId: second.id });
  let at = Date.now(), received = false, repairs = 0;
  let beforePrepare = () => {};
  let service: DeliveryRecovery;
  const inspectDelivery = async (_member: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection> => ({
    finding: received ? "received" : "not_received",
    receivedDeliveryIds: received ? query.markers.map(m => m.deliveryId) : [],
    evidence: [{ source: "claude_log", verdict: received ? "present" : "absent", location: "received_input", code: received ? "user_record" : "complete_range_without_marker", complete: true, checkedAt: new Date(at).toISOString() }],
    quiescence: "settled",
    snapshot: { identity: query.identity, observedAt: new Date(at).toISOString(), turn: 1, inputEpoch: 1, ownership: "verified", status: "idle", blockedReason: null, leaseActive: false, mutation: "none", composer: "empty", originalWrite: "settled", externalInput: false },
  });
  const repairDelivery = async (target: RunnerMember, request: DeliveryRepair): Promise<SendResult> => {
    const dispatch = service.repair.load(target.id, request);
    if (!dispatch) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
    beforePrepare();
    if (!service.repair.prepare(target.id, request, dispatch)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
    repairs++;
    return { ok: true, receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date(at).toISOString(), source: "transport" } };
  };
  service = new DeliveryRecovery({ store, runner: () => ({ inspectDelivery, repairDelivery }), now: () => at, random: () => 0,
    canRepair: (target, deliveries) => deliveries.every(d => store.taskSequenceBlocker(target.id, store.deliveryTaskId(d.id)) === null),
  });
  const original = service.prepareDispatch([later.id], { terminalId: member.paneId, sessionId: member.sessionId, sessionGeneration: 0, process: null }, { serverEpoch: "isolated", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date(at).toISOString() });
  service.recordResult(original.dispatchId, { ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" });
  return { store, project, member, first, later, original, service,
    async due() { at = Date.parse(store.getDeliveryRecovery(later.id)!.nextCheckAt!); await service.tick(); },
    get repairs() { return repairs; }, set received(value: boolean) { received = value; },
    set beforePrepare(value: () => void) { beforePrepare = value; },
    done() { store.addStageMark({ projectId: project.id, taskId: first.id, stage: "done", evidence: "Isolated fixture completion", memberId: null, who: "Fixture" }); },
    async close() { await service.shutdown(); db.close(); },
  };
}

test("recovery waits for the earlier task before reserving a resend envelope", async () => {
  const f = fixture();
  try {
    await f.service.tick();
    await f.due();
    expect(f.repairs).toBe(0);
    expect(f.store.listDispatches(f.member.id).map(d => d.dispatchId)).toEqual([f.original.dispatchId]);
    expect(f.store.physicalDeliveryIds()).toHaveLength(0);
    f.done();
    await f.due();
    expect(f.repairs).toBe(1);
    expect(f.store.requireDelivery(f.later.id).status).toBe("delivered");
  } finally { await f.close(); }
});

test("receipt reconciliation remains active while the later task cannot be resubmitted", async () => {
  const f = fixture();
  try {
    await f.service.tick();
    f.received = true;
    await f.due();
    expect(f.store.requireDelivery(f.later.id).status).toBe("delivered");
    expect(f.repairs).toBe(0);
    expect(f.store.listDispatches(f.member.id)).toHaveLength(1);
  } finally { await f.close(); }
});

test("a task reopened during the final repair check prevents the write without leaving a new physical fence", async () => {
  const f = fixture();
  try {
    f.done();
    await f.service.tick();
    f.beforePrepare = () => { f.store.addStageMark({ projectId: f.project.id, taskId: f.first.id, stage: "reopen", evidence: "More work found before repair", memberId: null, who: "Fixture" }); };
    await f.due();
    expect(f.repairs).toBe(0);
    expect(f.store.physicalDeliveryIds()).toHaveLength(0);
    expect(f.store.getDispatch(f.original.dispatchId)?.transportState).toBe("accepted");
    expect(f.store.listDispatches(f.member.id).at(-1)?.transportState).toBe("rejected");
  } finally { await f.close(); }
});
