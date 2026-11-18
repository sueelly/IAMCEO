import { expect, test } from "bun:test";
import { join } from "node:path";
import { Orchestrator } from "../server/orchestrator.ts";
import { CoreRunner } from "../server/runner/core.ts";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";

type Fixture = Awaited<ReturnType<typeof createQueueStatusFixture>>;

async function coldRuntime(f: Fixture) {
  await f.orch.shutdown();
  // This existing session has already applied its native CLI preference.
  f.store.setParallelApplied(f.member.id, f.member.parallel);
  const homes = { claudeHome: join(f.dir, "claude"), codexHome: join(f.dir, "codex") };
  const runner = new CoreRunner({ ...homes, contextHome: f.dir, socketPath: f.config.coreSocket,
    claudeBin: "/usr/bin/false", codexBin: "/usr/bin/false" }, { recoveryStore: f.store, pollMs: 10 });
  const orch = new Orchestrator({ config: f.config, store: f.store, runners: new Map([["core", runner]]),
    providerHomes: homes, timings: { healthMs: 60_000, tickMs: 60_000 } });
  orch.setServerUrl("http://127.0.0.1:1");
  expect(runner.observationState(f.member.id)).toBeNull();
  return orch;
}

function enqueue(f: Fixture, text: string) {
  return f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text, wake: true });
}

function stageAttempt(f: Fixture, deliveryId: string) {
  const initial = f.runner.observationState(f.member.id)!;
  const dispatch = f.orch.deliveryRecovery.prepareDispatch([deliveryId], initial.identity,
    { serverEpoch: "previous-server", turn: initial.turn, inputEpoch: initial.inputEpoch, logs: [], capturedAt: new Date().toISOString() });
  f.store.updateDispatch(dispatch.dispatchId, "prepared", "write_started");
  f.store.setDeliveryStatus(deliveryId, "delivering", { attempt: true });
  return dispatch.dispatchId;
}

for (const previouslyRejected of [false, true]) {
  test(`cold Core rejoins the owned idle terminal before sending a ${previouslyRejected ? "previously rejected" : "new"} instruction`, async () => {
    const f = await createQueueStatusFixture();
    let cold: Orchestrator | undefined;
    try {
      const d = enqueue(f, "Original instruction");
      if (previouslyRejected) {
        const previous = stageAttempt(f, d.id);
        f.store.updateDispatch(previous, "write_started", "rejected");
        expect(f.orch.deliveryRecovery.requeueRejected(d.id)).toBe(true);
      }
      cold = await coldRuntime(f);
      await cold.pump(f.member.id);
      const history = f.store.listDeliveryDispatches(d.id);
      expect(history.map(x => x.transportState)).toEqual(previouslyRejected ? ["rejected", "accepted"] : ["accepted"]);
      expect(history.at(-1)!.baseline.inputEpoch).toEqual(expect.any(Number));
      expect(history.at(-1)!.baseline.turn).toBe(0);
      expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "delivered", attempts: previouslyRejected ? 2 : 1 });
      await cold.pump(f.member.id);
      expect(f.writes).toEqual([{ terminal: f.member.paneId!, text: history.at(-1)!.wireText }]);
      expect(f.terminals.size).toBe(1);
    } finally { await cold?.shutdown(); await f.stop(); }
  });
}

test("a cold Core pump preserves a previous unresolved send", async () => {
  const f = await createQueueStatusFixture();
  let cold: Orchestrator | undefined;
  try {
    const prior = enqueue(f, "Possible prior physical write");
    const previous = stageAttempt(f, prior.id);
    f.store.updateDispatch(previous, "write_started", "unknown");
    const next = enqueue(f, "Wait for proof");
    cold = await coldRuntime(f);
    await cold.pump(f.member.id);
    expect(f.store.getDispatch(previous)?.transportState).toBe("unknown");
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.store.listDeliveryDispatches(next.id)).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
  } finally { await cold?.shutdown(); await f.stop(); }
});

for (const inventory of ["duplicate", "missing"] as const) {
  test(`a cold pump leaves the instruction untouched when its owned terminal inventory is ${inventory}`, async () => {
    const f = await createQueueStatusFixture();
    let cold: Orchestrator | undefined;
    try {
      cold = await coldRuntime(f);
      const original = f.terminals.get(f.member.paneId!)!;
      if (inventory === "duplicate") f.terminals.set("duplicate", { ...original, address: "duplicate" });
      else f.terminals.clear();
      const before = [...f.terminals.keys()];
      const d = enqueue(f, "Only the original holder may receive this instruction");
      await cold.pump(f.member.id);
      expect(f.store.listDeliveryDispatches(d.id)).toHaveLength(0);
      expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "queued", attempts: 0 });
      expect(f.store.requireMember(f.member.id).deliveryWait?.kind).toBe("session");
      expect(f.writes).toHaveLength(0);
      expect([...f.terminals.keys()]).toEqual(before);
    } finally { await cold?.shutdown(); await f.stop(); }
  });
}

test("a cold pump waits through a manual lease and sends the same input after release", async () => {
  const f = await createQueueStatusFixture();
  let cold: Orchestrator | undefined;
  try {
    const identity = f.runner.observationState(f.member.id)!.identity;
    f.store.saveLease({ memberId: f.member.id, claimId: "manual-claim", leaseId: "manual-lease",
      identity, expiresAt: Date.now() + 60_000, lastInputSequence: 0 });
    cold = await coldRuntime(f);
    const d = enqueue(f, "Wait for the operator");
    await cold.pump(f.member.id);
    expect(f.store.listDeliveryDispatches(d.id)).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    expect(f.store.requireMember(f.member.id).deliveryWait?.kind).toBe("manual_control");
    f.store.removeLease(f.member.id, "manual-claim");
    await cold.pump(f.member.id);
    expect(f.store.requireDelivery(d.id)).toMatchObject({ status: "delivered", attempts: 1 });
    expect(f.writes).toHaveLength(1);
  } finally { await cold?.shutdown(); await f.stop(); }
});
