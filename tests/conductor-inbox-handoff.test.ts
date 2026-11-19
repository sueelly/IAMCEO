import { expect, test } from "bun:test";
import { formatTidy } from "../server/orchestrator.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

function setup(stopped: boolean) {
  const f = fixture();
  const older = f.store.ensureSourceTask({ projectId: f.project.id, title: "이전 작업", origin: "owner", sourceRef: "stopped-scope" }).task;
  const stale = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: older.id, kind: "system", text: "이전 작업의 진행 확인" });
  const physical = f.orch.deliveryRecovery.prepareDispatch([stale.id], {
    terminalId: f.lead.paneId, sessionId: f.lead.sessionId, sessionGeneration: 0, process: null,
  }, { serverEpoch: "previous", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date().toISOString() });
  f.store.updateDispatch(physical.dispatchId, "prepared", "write_started");
  f.store.setDeliveryStatus(stale.id, "failed", { lastError: "수신 불명" });
  if (stopped) f.store.updateDeliveryRecovery(stale.id, f.store.getDeliveryRecovery(stale.id)!.version, { phase: "stopped" });
  return { ...f, stale, physical };
}

test("총괄이 재전송을 중지한 이전 입력은 그대로 두고 미전송 대표 지시만 별도 총괄 세션으로 보낸다", async () => {
  const f = setup(true);
  const req = { id: "new-directive", text: "두 작업의 의존성을 확인하고 각 담당자에게 배정해줘", intent: "execute" as const };
  await f.orch.sendUserMessage(f.project.id, req);
  const original = f.store.listDeliveries(f.project.id).filter(d => d.refId === req.id);
  expect(original).toHaveLength(1);
  expect(original[0]!.memberId).not.toBe(f.lead.id);
  const relief = f.store.requireMember(original[0]!.memberId);
  expect(relief.kind).toBe("conductor");
  expect(relief.cli).toBe(f.lead.cli);
  expect(f.runner.to(relief).join(" ")).toContain(req.text);
  expect(f.runner.to(relief).join(" ")).not.toContain(f.stale.text);
  await f.orch.sendUserMessage(f.project.id, req);
  expect(f.runner.to(relief)).toHaveLength(1);
  expect(f.store.getConductor(f.project.id)?.id).toBe(f.lead.id);
  expect(f.store.requireDelivery(f.stale.id).status).toBe("failed");
  expect(f.store.getDeliveryRecovery(f.stale.id)?.phase).toBe("stopped");
  expect(f.store.getDispatch(f.physical.dispatchId)?.transportState).toBe("write_started");
  expect(f.runner.to(f.lead)).toHaveLength(0);
});

test("재전송 중지나 실제 대표 원문 없이 대체 세션을 열지 않는다", async () => {
  const f = setup(false);
  const req = { id: "waiting", text: "팀의 의존성을 조정해줘", intent: "execute" as const };
  await f.orch.sendUserMessage(f.project.id, req);
  expect(f.store.listDeliveries(f.project.id).find(d => d.refId === req.id)?.memberId).toBe(f.lead.id);
  expect(f.store.listMembers(f.project.id).filter(m=>m.kind === "conductor")).toHaveLength(1);
});

test("미완료 판 정리는 수신 대행으로 한 번만 연결하고 임의의 시스템 알림은 원래 기록에 둔다", async () => {
  const f = setup(true);
  const at = new Date().toISOString();
  f.store.requestBoardReview(f.project.id, at);
  const board = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "system", text: formatTidy("conductor", false) });
  const other = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "system", text: "판 정리를 흉내 낸 알림" });
  await f.orch.pump(f.lead.id);
  expect(f.store.requireDelivery(board.id).memberId).not.toBe(f.lead.id);
  expect(f.store.requireDelivery(other.id).memberId).toBe(f.lead.id);
  expect((await f.orch.tidyBoard(f.project.id)).already).toBe(true);
});

test("직원이 남긴 실제 막힘만 수신 대행에게 연결하고, 대표 지시로 취급하거나 진행 보고를 다시 보내지 않는다", async () => {
  const f = setup(true);
  const task = f.store.ensureSourceTask({ projectId: f.project.id, title: "자료 대조", origin: "owner", sourceRef: "input-scope" }).task;
  const report = f.store.createMessage({ projectId: f.project.id, taskId: task.id, kind: "막힘", memberId: f.worker.id,
    who: f.worker.name, title: "다른 담당자의 자료가 필요합니다", body: "검산할 입력이 없습니다" });
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "report", taskId: task.id,
    text: report.title!, refType: "message", refId: report.id });
  await f.orch.pump(f.lead.id);
  expect(f.store.requireDelivery(delivery.id).memberId).not.toBe(f.lead.id);
  expect(f.store.requireMessage(report.id).memberId).toBe(f.worker.id);
});

test("대표가 총괄을 지정한 원문은 대행 영수증이 일치해야 전송되며 원 수신자와 실제 수신자를 함께 보존한다", async () => {
  const f = setup(true);
  const original = await f.orch.sendUserMessage(f.project.id, { id: "direct-to-lead", targetMemberId: f.lead.id, text: "기존 범위 안에서 두 담당 업무를 조정해줘" });
  const input = f.store.listDeliveries(f.project.id).find(d => d.kind === "user_message" && d.refId === original.id)!;
  const relief = f.store.requireMember(input.memberId);
  expect(relief.id).not.toBe(f.lead.id);
  expect(f.runner.to(relief).join(" ")).toContain(original.body);
  expect(input.status).toBe("delivered");
  const message = f.store.requireMessage(original.id);
  expect(message.targetMemberId).toBe(f.lead.id);
  expect(message.deliveryNote).toContain(relief.name);
  expect(f.orch.deliveryRecovery.sourceRevision(input)).not.toBeNull();
  expect(f.orch.deliveryRecovery.sourceRevision({ ...input, id: "unrelated" })).toBeNull();
  expect(f.orch.deliveryRecovery.sourceRevision({ ...input, memberId: f.worker.id })).toBeNull();
});
