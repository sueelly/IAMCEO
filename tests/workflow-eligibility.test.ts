import { expect, test } from "bun:test";
import { MIGRATIONS } from "../server/db.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

const cases = [
  { name: "stopped queued history", phase: "stopped", reason: null, history: [], delivered: false, active: false, eligible: false },
  { name: "resolved queued history", phase: "resolved", reason: null, history: [], delivered: false, active: false, eligible: false },
  { name: "unproven absence", phase: "resolved", reason: "not_received", history: [], delivered: false, active: false, eligible: false },
  { name: "stopped input referenced by an unfinished execution", phase: "stopped", reason: null, history: [], delivered: false, active: true, eligible: false },
  { name: "resolved queued input referenced by an unfinished execution", phase: "resolved", reason: null, history: [], delivered: false, active: true, eligible: false },
  { name: "confirmed pre-write refusal", phase: "resolved", reason: "not_received", history: ["rejected"], delivered: false, active: false, eligible: true },
  { name: "accepted attempt after an older refusal", phase: "resolved", reason: "not_received", history: ["rejected", "accepted"], delivered: false, active: false, eligible: false },
  { name: "received active assignment", phase: "resolved", reason: null, history: ["accepted"], delivered: true, active: true, eligible: true },
  { name: "delivered history outside any current execution", phase: "resolved", reason: null, history: ["accepted"], delivered: true, active: false, eligible: false },
] as const;

test.each(cases)("migration 37 keeps task-sequence eligibility for $name", scenario => {
  const f = fixture();
  const task = (title: string) => f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: `eligibility:${title}`, title, origin: "owner" }).task;
  const oldTask = task("Previous task"), nextTask = task("Next task");
  const old = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: oldTask.id, kind: "instruction", text: "Historical input", wake: true });
  const at = new Date().toISOString();
  const identity = { terminalId: f.worker.paneId, sessionId: f.worker.sessionId, sessionGeneration: 0, process: null };
  for (const state of scenario.history) {
    const dispatch = f.orch.deliveryRecovery.prepareDispatch([old.id], identity, { serverEpoch: "eligibility-test", turn: 0, inputEpoch: 0, logs: [], capturedAt: at });
    f.store.updateDispatch(dispatch.dispatchId, "prepared", state);
  }
  if (scenario.delivered) f.store.markDelivered(old.id);
  const recovery = f.store.getDeliveryRecovery(old.id)!;
  f.store.updateDeliveryRecovery(old.id, recovery.version, { phase: scenario.phase, reason: scenario.reason });
  if (scenario.active) f.store.saveExecutionJournal({ runId: "legacy-active", memberId: f.worker.id, projectId: f.project.id, identity, turn: 0, deliveryIds: [old.id], phase: "received", inputReceivedAt: at, startedAt: null, lastProgressAt: null, endedAt: null, result: null, reason: null, exitCode: null, interruptionNotifiedAt: null, reportRequestedAt: null, createdAt: at, updatedAt: at });
  f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: nextTask.id, kind: "instruction", text: "Next input", wake: true });
  // A post-migration delivered assignment remains a predecessor. Adoption of
  // older data only enrolls one with a current execution, not all old receipts.
  const currentBlocker = f.store.taskSequenceBlocker(f.worker.id, nextTask.id)?.taskId ?? null;
  const before = f.store.listDeliveries();
  f.store.db.exec("DROP TABLE task_sequence");
  f.store.db.exec(MIGRATIONS.find(sql => sql.includes("CREATE TABLE task_sequence"))!);
  const enrolled = f.store.db.query("SELECT 1 FROM task_sequence WHERE member_id = ? AND task_id = ?").get(f.worker.id, oldTask.id);
  expect(enrolled !== null).toBe(scenario.eligible);
  expect(f.store.taskSequenceBlocker(f.worker.id, nextTask.id)?.taskId ?? null).toBe(scenario.eligible ? oldTask.id : null);
  expect(currentBlocker).toBe(scenario.eligible || scenario.delivered ? oldTask.id : null);
  expect(f.store.listDeliveries()).toEqual(before);
});
