import { expect, test } from "bun:test";
import { checkCompletionReviews, latestCompletionReview } from "../server/task-completion.ts";
import { until } from "./fixtures/harness-fixture.ts";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";

test("an existing unwritten review reaches only its standby terminal once while the primary receipt and approval stay open", async () => {
  const f = await createQueueStatusFixture();
  try {
    const { store, orch, project } = f;
    const conductor = store.createMember({ projectId: project.id, handle: "lead", name: "총괄", kind: "conductor", origin: "manual", cli: "claude" });
    const primary = store.ensureFinalReviewer(project.id)!;
    const opened = await orch.resumeMember(primary.id);
    const createReport = async (title: string) => {
      const task = orch.saveTask(conductor, { title, contract: { kind: "other", goal: title, scope: "해당 인계 자료",
        inputs: ["직원 초안"], outputs: ["인계 자료"], constraints: [], exclusions: [], acceptance: ["원문과 일치한다"], checks: [] } }).task;
      const report = await orch.recordPost(f.member, { taskId: task.id, kind: "완료", title: title + " 대조", contractRev: 1,
        checks: [{ name: "원문 대조", kind: "other", result: "pass", evidence: "원문과 자료의 항목을 대조했습니다", criterion: 1 }] });
      return { task, report };
    };
    const now = Date.now();
    const first = await createReport("첫째 자료");
    const [original] = checkCompletionReviews(store, now + 60_000, 30_000);
    expect(original).toMatchObject({ memberId: primary.id, taskId: first.task.id });
    await orch.pump(primary.id);
    expect(store.requireDelivery(original!.id)).toMatchObject({ status: "delivered", attempts: 1 });
    const originalWrites = f.writes.filter(w => w.terminal === opened.paneId);
    expect(originalWrites).toHaveLength(1);
    expect(originalWrites[0]!.text).toContain(first.report.id);
    const second = await createReport("별도 자료");
    const [queued] = checkCompletionReviews(store, now + 120_000, 30_000);
    expect(queued).toMatchObject({ memberId: primary.id, taskId: second.task.id, attempts: 0, status: "queued" });
    expect(store.listDeliveryDispatches(queued!.id)).toHaveLength(0);

    // The earlier transport was accepted; the conversation still needs its owner's receipt decision.
    expect(store.listDeliveryDispatches(original!.id)[0]?.transportState).toBe("accepted");
    store.markHeld(original!.id, "delivery_unknown");
    const recovery = store.getDeliveryRecovery(original!.id)!;
    store.updateDeliveryRecovery(original!.id, recovery.version, { phase: "needs_owner", reason: "complete_range_without_marker" });
    const before = store.requireDelivery(original!.id);
    const originalDispatches = store.listDeliveryDispatches(original!.id);
    const approval = store.createDecision({ projectId: project.id, memberId: primary.id, who: primary.name,
      detail: `기존 검수 보고 #${first.report.id}의 전달 #${original!.id} 수신을 확인해 주세요.`,
      title: "첫째 자료의 기존 수신을 어떻게 처리할까요?", options: [{ k: "check", label: "확인" }, { k: "hold", label: "보류" }] });
    expect(approval.status).toBe("open");
    expect(store.hasLogicalDeliveryFence(primary.id)).toBe(true);
    const terminal = f.terminals.get(opened.paneId!)!;
    terminal.turn = (terminal.turn ?? 0) + 1;
    terminal.status = { state: "done", app: "claude-code" };
    await until("first review terminal finishes its turn", () => !store.listPendingExecutions().some(run => run.memberId === primary.id));
    expect(orch.deliveryRecovery.fenced(primary.id)).toBe(true);

    const service = async (tick: number) => {
      orch.checkTaskContinuations(tick);
      await Promise.all(store.listMembers(project.id).filter(m => m.finalReviewer).map(m => orch.pump(m.id)));
    };
    await service(now + 150_000);
    const writes = f.writes.filter(w => w.text.includes(second.report.id));
    expect(writes).toHaveLength(1);
    const standby = store.getMemberByPane(writes[0]!.terminal)!;
    expect(standby.id).not.toBe(primary.id);
    expect(standby.finalReviewer).toBe(true);
    expect(writes[0]!.text).not.toContain(first.report.id);
    const delivered = store.requireDelivery(latestCompletionReview(store, second.task.id)!.delivery_id!);
    expect(delivered).toMatchObject({ memberId: standby.id, status: "delivered", attempts: 1 });
    expect(store.listDeliveryDispatches(queued!.id)).toHaveLength(0);

    await service(now + 160_000);
    expect(f.writes.filter(w => w.text.includes(second.report.id))).toEqual(writes);

    const verdict = { task_id: second.task.id, report_id: second.report.id, result: "confirmed", evidence: "별도 자료와 계약을 대조했습니다" };
    for (const other of [f.member, primary]) {
      expect((await orch.handleAgentTool(other, "task_review", verdict)).isError).toBe(true);
    }
    expect((await orch.handleAgentTool(standby, "task_review_evidence", { task_id: first.task.id, report_id: first.report.id })).isError).toBe(true);
    const evidence = await orch.handleAgentTool(standby, "task_review_evidence", { task_id: second.task.id, report_id: second.report.id });
    expect(evidence.isError, evidence.text).toBeUndefined();
    const result = await orch.handleAgentTool(standby, "task_review", verdict);
    expect(result.isError, result.text).toBeUndefined();
    await service(now + 180_000);
    expect(f.writes.filter(w => w.text.includes(second.report.id))).toEqual(writes);
    expect(f.writes.filter(w => w.terminal === opened.paneId)).toEqual(originalWrites);
    expect(f.keys).toEqual([]);
    expect(store.requireDelivery(original!.id)).toEqual(before);
    expect(store.listDeliveryDispatches(original!.id)).toEqual(originalDispatches);
    expect(store.getDeliveryRecovery(original!.id)).toMatchObject({ phase: "needs_owner", reason: "complete_range_without_marker" });
    expect(store.getDecision(approval.id)).toEqual(approval);
    expect(latestCompletionReview(store, first.task.id)?.status).toBe("pending");
  } finally { await f.stop(); }
});
