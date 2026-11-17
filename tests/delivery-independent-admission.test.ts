import { expect, test } from "bun:test";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";

type Fixture = Awaited<ReturnType<typeof createQueueStatusFixture>>;
type IndependentRequest = { operationId: string; sourceMessageId: string;
  expectedSessionGeneration: number; expectedBlockerTaskId: string };
type IndependentAuthorizer = { authorizeIndependentDelivery(projectId: string, deliveryId: string,
  request: IndependentRequest): Promise<{ deliveryId: string }> };

function authorization(f: Fixture, deliveryId: string, blockerTaskId: string) {
  const source = f.store.createMessage({ projectId: f.project.id, taskId: blockerTaskId,
    targetMemberId: f.member.id, mine: true, who: "대표", kind: "나",
    body: "앞선 업무와 결재는 그대로 두고, 선택한 독립 업무의 기존 지시만 먼저 받으세요." });
  const request = { operationId: crypto.randomUUID(), sourceMessageId: source.id,
    expectedSessionGeneration: f.store.memberRevisions(f.member.id).sessionGeneration,
    expectedBlockerTaskId: blockerTaskId };
  // The public method is introduced with this regression; do not add test hooks to production.
  const authorize = async () => (f.orch as unknown as IndependentAuthorizer)
    .authorizeIndependentDelivery(f.project.id, deliveryId, request);
  return { request, authorize };
}

async function until(what: string, read: () => boolean) {
  for (let i = 0; i < 150 && !read(); i++) await Bun.sleep(5);
  if (!read()) throw new Error(`Timed out waiting for ${what}`);
}

function task(f: Fixture, sourceRef: string, title: string) {
  return f.store.ensureSourceTask({ projectId: f.project.id, sourceRef, title, origin: "owner" }).task;
}

function instruction(f: Fixture, taskId: string, text: string) {
  return f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId,
    kind: "instruction", text, wake: true });
}

function heldPredecessor(f: Fixture, parallel: boolean) {
  f.store.patchMember(f.member.id, { parallel });
  const previous = task(f, "independent:previous", "Previous work awaiting owner review");
  const original = instruction(f, previous.id, "Original previous instruction; never replay");
  f.store.markDelivered(original.id);
  f.store.addStageMark({ projectId: f.project.id, taskId: previous.id, stage: "hold",
    evidence: "Owner must review this task before it continues", memberId: null, who: "Fixture" });
  const approval = f.store.createDecision({ projectId: f.project.id, taskId: previous.id,
    memberId: f.member.id, who: f.member.name, title: "May the previous task continue?",
    options: [{ k: "yes", label: "Continue previous work" }, { k: "no", label: "Keep waiting" }] });
  const protectedInput = instruction(f, previous.id, "Protected previous-task input; never replay");
  f.store.markHeld(protectedInput.id, "delivery_unknown");
  const recovery = f.store.getDeliveryRecovery(protectedInput.id)!;
  f.store.updateDeliveryRecovery(protectedInput.id, recovery.version,
    { phase: "stopped", reason: "restore_reconciliation_required" });
  const before = {
    original: f.store.requireDelivery(original.id), protectedInput: f.store.requireDelivery(protectedInput.id),
    recovery: f.store.getDeliveryRecovery(protectedInput.id), approval: f.store.getDecision(approval.id),
    marks: f.store.listStageMarks(previous.id),
  };
  const unchanged = () => {
    expect(f.store.requireDelivery(original.id)).toEqual(before.original);
    expect(f.store.requireDelivery(protectedInput.id)).toEqual(before.protectedInput);
    expect(f.store.getDeliveryRecovery(protectedInput.id)).toEqual(before.recovery);
    expect(f.store.getDecision(approval.id)).toEqual(before.approval);
    expect(f.store.listStageMarks(previous.id)).toEqual(before.marks);
    expect(f.store.doneMark(previous.id)).toBeNull();
  };
  return { previous, original, protectedInput, approval, unchanged };
}

test("explicit owner authorization admits the selected independent original once while another employee works", async () => {
  const f = await createQueueStatusFixture(2);
  try {
    const previous = heldPredecessor(f, false);
    const other = await f.orch.createMember(f.project.id, { name: "Other active fixture worker", cli: "claude" });
    f.store.enqueue({ projectId: f.project.id, memberId: other.id, kind: "instruction",
      text: "Independent active employee work", wake: true });
    await f.orch.pump(other.id);
    expect(f.writes).toHaveLength(1);

    const nextTask = task(f, "independent:next", "Independent approved work");
    const next = instruction(f, nextTask.id, "Exact new original instruction");
    const ungranted = instruction(f, nextTask.id, "Separate original without an independent authorization");
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "queued", attempts: 0 });
    const grant = authorization(f, next.id, previous.previous.id);
    const receipt = await grant.authorize();
    expect(receipt).toMatchObject({ deliveryId: next.id });
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(next.id)).toMatchObject({ id: next.id, status: "delivered", attempts: 1,
      text: "Exact new original instruction" });
    await f.orch.pump(f.member.id);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]!.terminal).toBe(f.member.paneId!);
    expect(f.writes[1]!.text.startsWith("Exact new original instruction\n")).toBe(true);
    expect(f.writes[1]!.text).not.toContain("Original previous instruction");
    expect(f.writes[1]!.text).not.toContain("Protected previous-task input");
    expect(f.writes[1]!.text).not.toContain("Separate original without an independent authorization");
    expect(f.store.requireDelivery(ungranted.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.store.listDeliveryDispatches(next.id)).toHaveLength(1);
    expect(f.store.listDeliveryDispatches(next.id)[0]!.transportState).toBe("accepted");
    expect(await grant.authorize()).toEqual(receipt);
    expect(f.store.listDeliveryDispatches(next.id)).toHaveLength(1);
    expect(f.writes).toHaveLength(2);
    previous.unchanged();
  } finally { await f.stop(); }
});

test.each([{ name: "disabled", parallel: false }, { name: "enabled", parallel: true }])(
  "parallel preference $name alone leaves the independent original queued at attempt zero", async ({ parallel }) => {
  const f = await createQueueStatusFixture();
  try {
    const previous = heldPredecessor(f, parallel);
    const next = instruction(f, task(f, "sequential:next", "Later sequential work").id, "Wait for previous work");
    await f.orch.pump(f.member.id);
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.store.listDeliveryDispatches(next.id)).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    previous.unchanged();
  } finally { await f.stop(); }
});

test("independent authorization rejects a protected same-task input", async () => {
  const f = await createQueueStatusFixture();
  try {
    const previous = heldPredecessor(f, true);
    const grant = authorization(f, previous.protectedInput.id, previous.previous.id);
    await expect(grant.authorize()).rejects.toMatchObject({ status: 409 });
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(previous.protectedInput.id)).toMatchObject({ status: "held", attempts: 0 });
    expect(f.store.listDeliveryDispatches(previous.protectedInput.id)).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    previous.unchanged();
  } finally { await f.stop(); }
});

test("independent authorization rejects a related derived task", async () => {
  const f = await createQueueStatusFixture();
  try {
    const previous = heldPredecessor(f, false);
    const child = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "independent:child",
      title: "Continuation of the protected task", origin: "owner", parentTaskId: previous.previous.id }).task;
    const input = instruction(f, child.id, "Related continuation requires its own authorization");
    await expect(authorization(f, input.id, previous.previous.id).authorize()).rejects.toMatchObject({ status: 409 });
    expect(f.store.listDeliveryDispatches(input.id)).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    previous.unchanged();
  } finally { await f.stop(); }
});

test.each(["busy", "lease", "uncertain", "capacity"] as const)("explicit independent authorization retains the %s input fence", async fence => {
  const f = await createQueueStatusFixture();
  try {
    const previous = heldPredecessor(f, false);
    const observed = f.runner.observationState(f.member.id)!;
    let uncertain: string | null = null;
    if (fence === "busy") {
      f.terminals.get(f.member.paneId!)!.status = { state: "working", app: "claude-code" };
      await f.orch.memberScreen(f.member.id);
      await until("active employee observation", () => f.store.requireMember(f.member.id).status === "working");
    }
    if (fence === "lease") f.store.saveLease({ memberId: f.member.id, claimId: "fixture-claim", leaseId: "fixture-lease",
      identity: observed.identity, expiresAt: Date.now() + 60_000, lastInputSequence: 0 });
    if (fence === "uncertain") {
      const old = instruction(f, task(f, "fence:old", "Unknown physical input").id, "Possibly written original");
      const dispatch = f.orch.deliveryRecovery.prepareDispatch([old.id], observed.identity,
        { serverEpoch: "independent-admission-test", turn: observed.turn, inputEpoch: observed.inputEpoch,
          logs: [], capturedAt: new Date().toISOString() });
      f.store.updateDispatch(dispatch.dispatchId, "prepared", "unknown");
      uncertain = dispatch.dispatchId;
    }
    if (fence === "capacity") {
      f.store.patchSettings({ maxConcurrentTurns: 1 });
      const other = await f.orch.createMember(f.project.id, { name: "Capacity fixture worker", cli: "claude" });
      f.store.enqueue({ projectId: f.project.id, memberId: other.id, kind: "instruction",
        text: "Occupy the only automatic slot", wake: true });
      await f.orch.pump(other.id);
      expect(f.writes).toHaveLength(1);
    }
    const next = instruction(f, task(f, "fence:next", "Safe work behind a terminal fence").id, "Do not cross terminal fence");
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "queued", attempts: 0 });
    await authorization(f, next.id, previous.previous.id).authorize();
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.store.listDeliveryDispatches(next.id)).toHaveLength(0);
    expect(f.writes.filter(write => write.terminal === f.member.paneId)).toHaveLength(0);
    expect(f.keys).toHaveLength(0);
    if (uncertain) expect(f.store.getDispatch(uncertain)?.transportState).toBe("unknown");
    previous.unchanged();
  } finally { await f.stop(); }
});

test("a normal turn end resumes an authorized independent original once without an explicit pump", async () => {
  const f = await createQueueStatusFixture();
  try {
    f.store.patchMember(f.member.id, { parallel: false });
    const firstTask = task(f, "normal-end:first", "Current approved work");
    const first = instruction(f, firstTask.id, "First original instruction");
    await f.orch.pump(f.member.id);
    const nextTask = task(f, "normal-end:next", "Next independent approved work");
    const next = instruction(f, nextTask.id, "Queued original after normal end");
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.writes).toHaveLength(1);
    await authorization(f, next.id, firstTask.id).authorize();
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "queued", attempts: 0 });
    await f.orch.recordPost(f.store.requireMember(f.member.id), { taskId: firstTask.id,
      kind: "진행", title: "Current turn has reported its result" });
    f.done();
    // No manual pump or fake task completion: the normal end must reenter delivery.
    await until("automatic next original delivery", () => f.store.requireDelivery(next.id).status === "delivered");
    await Bun.sleep(40);
    expect(f.writes).toHaveLength(2);
    expect(f.store.requireDelivery(first.id)).toMatchObject({ status: "delivered", attempts: 1 });
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "delivered", attempts: 1 });
    expect(f.store.listDeliveryDispatches(next.id)).toHaveLength(1);
    expect(f.writes[1]!.text).toContain("Queued original after normal end");
    expect(f.writes[1]!.text).not.toContain("First original instruction");
    expect(f.keys).toHaveLength(0);
  } finally { await f.stop(); }
});
