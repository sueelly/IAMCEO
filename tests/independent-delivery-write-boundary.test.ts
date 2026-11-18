import { reviewedPlacement } from "./fixtures/reviewed-placement.ts";
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";

type Fixture = Awaited<ReturnType<typeof createQueueStatusFixture>>;

function setupWork(f: Fixture) {
  const previous = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "boundary:previous",
    title: "Previous work awaiting owner approval", origin: "owner" }).task;
  const previousInput = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: previous.id,
    kind: "instruction", text: "Previous original must remain received exactly once", wake: true });
  f.store.markDelivered(previousInput.id);
  f.store.addStageMark({ projectId: f.project.id, taskId: previous.id, stage: "review",
    evidence: "Owner approval remains necessary for this previous task", memberId: null, who: "Fixture" });
  const previousDecision = f.store.createDecision({ projectId: f.project.id, memberId: f.member.id, taskId: previous.id,
    who: f.member.name, title: "May the previous task continue?", options: [{ k: "wait", label: "Keep waiting" }] });
  const target = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "boundary:target",
    title: "Independent approved task", origin: "owner" }).task;
  for (const task of [previous, target]) f.store.saveTaskContract(task.id, {
    kind: "other", goal: "독립 업무의 결과를 검증한다", inputs: ["확정된 지시"], outputs: ["검증 결과"],
    scope: "해당 업무만 수행", constraints: [], exclusions: [], acceptance: ["결과를 확인한다"], checks: [],
  }, { author: "Fixture", authorMemberId: null, authorKind: "owner" });
  const selected = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: target.id,
    kind: "instruction", text: "Selected original at the physical write boundary", wake: true });
  reviewedPlacement(f.store, selected);
  const source = f.store.createMessage({ projectId: f.project.id, taskId: previous.id, targetMemberId: f.member.id,
    mine: true, who: "대표", kind: "나", body: "앞선 업무와 결재는 보존하고 선택한 독립 업무의 기존 지시만 먼저 받으세요." });
  const before = { previousInput: f.store.requireDelivery(previousInput.id), previousDecision: f.store.getDecision(previousDecision.id),
    previousMarks: f.store.listStageMarks(previous.id) };
  const request = { operationId: randomUUID(), sourceMessageId: source.id,
    expectedSessionGeneration: f.store.memberRevisions(f.member.id).sessionGeneration,
    expectedBlockerTaskId: previous.id };
  const previousUnchanged = () => {
    expect(f.store.requireDelivery(previousInput.id)).toEqual(before.previousInput);
    expect(f.store.getDecision(previousDecision.id)).toEqual(before.previousDecision);
    expect(f.store.listStageMarks(previous.id)).toEqual(before.previousMarks);
    expect(f.store.doneMark(previous.id)).toBeNull();
  };
  return { previous, previousInput, previousDecision, target, selected, source, request, previousUnchanged };
}

/** Keep CoreRunner's real preflight, socket connection, admission callback and
 * terminal.send intact. Only the policy mutation is injected at the callback. */
function mutateAtWrite(f: Fixture, mutate: () => void) {
  const send = f.runner.send.bind(f.runner);
  let boundaries = 0;
  f.runner.send = (member, text, opts, urgent = false) => send(member, text, {
    ...opts,
    beforeWrite: () => {
      boundaries++;
      if (boundaries === 1) mutate();
      if (!opts.beforeWrite) throw new Error("The ordinary pump must provide its final admission callback");
      return opts.beforeWrite();
    },
  }, urgent);
  return () => boundaries;
}

function tripWatch(f: Fixture, taskId: string) {
  const at = new Date().toISOString();
  f.store.saveTaskWatch(f.project.id, taskId, { startedAt: at, attempts: 3, same: 3,
    fingerprint: "failure:boundary", lastProgressAt: at, trippedAt: at,
    reason: "The same verification failed three times", updatedAt: at, history: [] });
  return at;
}

function failureDecision(f: Fixture, taskId: string) {
  const at = tripWatch(f, taskId);
  const decision = f.store.createDecision({ projectId: f.project.id, taskId, memberId: f.member.id,
    who: "기존 실패 승인", title: "이전 정책에서 남은 대표 재시도 승인" });
  f.store.db.query("INSERT INTO task_failure_escalations(task_id,decision_id,tripped_at,created_at) VALUES(?,?,?,?)")
    .run(taskId, decision.id, at, at);
  return decision;
}

test("an unchanged independent authorization passes the real physical-write callback once", async () => {
  const f = await createQueueStatusFixture();
  try {
    const work = setupWork(f);
    await f.orch.pump(f.member.id);
    expect(f.store.requireDelivery(work.selected.id)).toMatchObject({ status: "queued", attempts: 0 });
    const boundaries = mutateAtWrite(f, () => {});
    const receipt = await f.orch.authorizeIndependentDelivery(f.project.id, work.selected.id, work.request);
    expect(receipt.deliveryId).toBe(work.selected.id);
    expect(boundaries()).toBe(1);
    expect(f.store.requireDelivery(work.selected.id)).toMatchObject({ id: work.selected.id, status: "delivered", attempts: 1 });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.text.startsWith("Selected original at the physical write boundary\n")).toBe(true);
    expect(f.store.listDeliveryDispatches(work.selected.id)).toHaveLength(1);
    expect(f.store.listDeliveryDispatches(work.selected.id)[0]!.transportState).toBe("accepted");
    await f.orch.pump(f.member.id);
    expect(f.writes).toHaveLength(1);
    expect(f.keys).toHaveLength(0);
    work.previousUnchanged();
  } finally { await f.stop(); }
});

for (const change of ["source body", "target lineage", "session generation", "effective contract", "target decision",
  "target failure decision", "descendant failure decision", "target intervention", "descendant intervention", "project capacity"] as const) {
  test(`changing ${change} at the physical-write callback refuses bytes without a received-input record`, async () => {
    const f = await createQueueStatusFixture(2);
    try {
      const work = setupWork(f);
      let pendingDecisionId: string | null = null;
      let unrelatedWrites = 0;
      if (change === "project capacity") {
        const other = await f.orch.createMember(f.project.id, { name: "Boundary capacity worker", cli: "claude" });
        f.store.enqueue({ projectId: f.project.id, memberId: other.id, kind: "instruction",
          text: "Existing independent work occupying one slot", wake: true });
        await f.orch.pump(other.id);
        expect(f.writes).toHaveLength(1);
        unrelatedWrites = 1;
      }
      await f.orch.pump(f.member.id);
      expect(f.store.requireDelivery(work.selected.id)).toMatchObject({ status: "queued", attempts: 0 });
      const boundaries = mutateAtWrite(f, () => {
        if (change === "source body") f.store.db.query("UPDATE messages SET body=? WHERE id=?")
          .run("Owner changed the authorization before physical input", work.source.id);
        else if (change === "target lineage") f.store.db.query("UPDATE tasks SET parent_task_id=? WHERE id=?")
          .run(work.previous.id, work.target.id);
        else if (change === "session generation") f.store.db.query("UPDATE members SET session_generation=session_generation+1 WHERE id=?")
          .run(f.member.id);
        else if (change === "effective contract") f.store.saveTaskContract(work.target.id,
          { ...f.store.getEffectiveContract(work.target.id)!, kind: "other", goal: "Changed approved task scope", acceptance: ["Review the changed criteria first"], checks: [] },
          { author: "대표", authorKind: "owner", authorMemberId: null, sourceMessageId: work.source.id });
        else if (change === "target decision") pendingDecisionId = f.store.createDecision({ projectId: f.project.id,
          taskId: work.target.id, memberId: f.member.id, who: f.member.name,
          title: "New owner condition before this target may run" }).id;
        else if (change === "target intervention") tripWatch(f, work.target.id);
        else if (change === "descendant intervention") {
          const child = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "boundary:intervention-child",
            title: "Stopped descendant", origin: "owner", parentTaskId: work.target.id }).task;
          tripWatch(f, child.id);
        }
        else if (change === "target failure decision") pendingDecisionId = failureDecision(f, work.target.id).id;
        else if (change === "descendant failure decision") {
          const child = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "boundary:failed-child",
            title: "Failed descendant of the target", origin: "owner", parentTaskId: work.target.id }).task;
          pendingDecisionId = failureDecision(f, child.id).id;
          expect(f.store.pendingTaskFailureDecision(work.target.id)?.id).toBe(pendingDecisionId);
        } else f.store.patchProject(f.project.id, { maxConcurrentTurns: 1 });
      });
      const receipt = await f.orch.authorizeIndependentDelivery(f.project.id, work.selected.id, work.request);
      expect(receipt.deliveryId).toBe(work.selected.id); // An order grant is not proof of physical receipt.
      expect(boundaries()).toBe(1);
      expect(f.writes).toHaveLength(unrelatedWrites);
      expect(f.writes.filter(write => write.terminal === f.member.paneId)).toHaveLength(0);
      expect(f.keys).toHaveLength(0);
      const selected = f.store.requireDelivery(work.selected.id);
      expect(selected).toMatchObject({ id: work.selected.id, status: "queued",
        text: "Selected original at the physical write boundary" });
      expect(selected.deliveredAt).toBeNull();
      const dispatches = f.store.listDeliveryDispatches(work.selected.id);
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]!.transportState).toBe("rejected");
      expect(f.store.getExecutionJournal(dispatches[0]!.dispatchId)?.inputReceivedAt).toBeNull();
      expect(f.store.listPendingExecutions().some(run => run.memberId === f.member.id)).toBe(false);
      if (pendingDecisionId) expect(f.store.requireDecision(pendingDecisionId).status).toBe("open");
      work.previousUnchanged();
    } finally { await f.stop(); }
  });
}
