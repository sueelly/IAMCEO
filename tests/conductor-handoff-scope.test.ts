import { expect, test } from "bun:test";
import { handoffConductorInputs } from "../server/conductor-intake.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

function setup(knownScope = true) {
  const f = fixture(), { store, project, lead, worker } = f;
  const task = (title: string, parentTaskId?: string) => store.ensureSourceTask({
    projectId: project.id, sourceRef: title, title, parentTaskId, origin: "owner",
  }).task;
  const parent = task("출판"), original = task("회차 발행", parent.id), child = task("발행 검사", original.id), separate = task("독자 화면");
  const stale = store.enqueue({ projectId: project.id, memberId: lead.id, kind: "system", wake: true,
    taskId: knownScope ? original.id : null, text: "회차 발행을 다시 배정해 주세요" });
  const dispatch = f.orch.deliveryRecovery.prepareDispatch([stale.id], { terminalId: lead.paneId, sessionId: lead.sessionId, sessionGeneration: 0, process: null },
    { serverEpoch: "prior", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date().toISOString() });
  store.updateDispatch(dispatch.dispatchId, "prepared", "unknown");
  store.setDeliveryStatus(stale.id, "failed", { lastError: "수신 불확실" });
  store.updateDeliveryRecovery(stale.id, store.getDeliveryRecovery(stale.id)!.version, { phase: "stopped" });
  const report = (taskId: string) => {
    const msg = store.createMessage({ projectId: project.id, taskId, memberId: worker.id, who: worker.name, title: "별도 자료 필요", kind: "막힘" });
    return store.enqueue({ projectId: project.id, memberId: lead.id, taskId, kind: "report", refId: msg.id, refType: "message", text: msg.title! });
  };
  const attention = (taskIds: string[]) => {
    const input = store.enqueue({ projectId: project.id, memberId: lead.id, kind: "system", text: "검수 전달 확인" });
    for (const taskId of taskIds) {
      const msg = store.createMessage({ projectId: project.id, taskId, memberId: worker.id, who: worker.name, title: "검사 근거", kind: "완료" });
      const mark = store.addStageMark({ projectId: project.id, taskId, stage: "done", memberId: null, who: "하네스", evidence: "통과" });
      store.db.query("INSERT INTO task_completion_reviews (report_id,task_id,contract_task_id,contract_rev,mark_id,status,completed_at,attention_delivery_id) VALUES(?,?,?,1,?,'pending',?,?)").run(msg.id, taskId, taskId, mark.id, msg.at, input.id);
    }
    return input;
  };
  const handoff = () => handoffConductorInputs(store, lead, store.listPending(lead.id), () => false, d => d.text);
  return { store, lead, original, parent, child, separate, stale, report, attention, handoff };
}

test("중지된 원 전송의 업무와 상·하위에 본 막힘은 보존하고 별도 업무만 대행에 전달한다", () => {
  const f = setup();
  const related = [f.original, f.parent, f.child].map(t => f.report(t.id)), independent = f.report(f.separate.id);
  const relief = f.handoff();
  expect(relief).toBeTruthy();
  expect(f.store.requireDelivery(independent.id).memberId).toBe(relief!);
  for (const d of related) expect(f.store.requireDelivery(d.id)).toMatchObject({ memberId: f.lead.id, status: "queued", attempts: 0 });
  expect(f.store.getDeliveryRecovery(f.stale.id)?.phase).toBe("stopped");
});

test("같은 검수 묶음에 중지한 업무의 하위가 하나라도 있으면 묶음 원문과 수신처를 보존한다", () => {
  const f = setup();
  const original = f.attention([f.separate.id, f.child.id]);
  expect(f.handoff()).toBeNull();
  expect(f.store.requireDelivery(original.id)).toMatchObject({ memberId: f.lead.id, status: "queued" });
});

test("실행성 원 전송의 업무를 모르면 자동 막힘 조정을 다른 세션에서 시작하지 않는다", () => {
  const f = setup(false), d = f.report(f.separate.id);
  expect(f.handoff()).toBeNull();
  expect(f.store.requireDelivery(d.id).memberId).toBe(f.lead.id);
});
