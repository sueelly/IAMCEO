import { expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { startServer } from "../server/http.ts";
import type { ContractInput } from "../server/harness.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

const contract: ContractInput = { kind: "other", goal: "공개된 월별 집계표를 검산한다", scope: "공개된 월별 집계표",
  inputs: ["월별 집계표"], outputs: ["검산 보고"], acceptance: ["월별 합계와 연간 합계가 일치한다"], constraints: [], exclusions: ["원본 변경"] };

function existing() {
  const f = fixture();
  const task = f.orch.saveTask(f.lead, { title: "집계 검산", contract }).task;
  const card = f.store.upsertWork({ projectId: f.project.id, sec: "doing", title: task.title, taskId: task.id, who: f.worker.name });
  return { ...f, task, card };
}

test("확정된 업무의 담당자는 총괄 전송이 미확정이어도 대표 원문을 한 번만 수신한다", async () => {
  const f = existing();
  // The lead's previous write is unresolved. This receipt cannot move to another inbox.
  const old = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, kind: "user_message", text: "이전 총괄 전용 글" });
  const physical = f.orch.deliveryRecovery.prepareDispatch([old.id], {
    terminalId: f.lead.paneId, sessionId: f.lead.sessionId, sessionGeneration: 0, process: null,
  }, { serverEpoch: "routing-test", turn: 0, inputEpoch: 0, logs: [], capturedAt: new Date().toISOString() });
  f.store.updateDispatch(physical.dispatchId, "prepared", "write_started");
  const prior = f.store.requireDelivery(old.id);
  const input = { id: "cmd-ready", text: "위 기준으로 검산을 마쳐줘", taskId: f.task.id, intent: "execute" as const };
  const sent = await f.orch.sendUserMessage(f.project.id, input);
  expect(sent.targetMemberId).toBe(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(1);
  expect(f.runner.to(f.worker)[0]).toContain(input.text);
  expect(f.runner.to(f.worker)[0]).toContain("업무 계약 r1");
  await f.orch.sendUserMessage(f.project.id, input);
  expect(f.store.listDeliveries(f.project.id).filter(d => d.refId === sent.id)).toHaveLength(1);
  expect(f.runner.to(f.worker)).toHaveLength(1);
  expect(f.store.requireDelivery(old.id)).toEqual(prior);
  expect(f.store.getDispatch(physical.dispatchId)?.transportState).toBe("write_started");
  expect(f.store.listDeliveries(f.project.id).filter(d => d.taskId === f.task.id && d.memberId === f.lead.id)).toHaveLength(0);
});

test("HTTP로 접수한 새 계약의 단일 담당 역할에 원문·계약을 함께 저장하고 직접 전달한다", async () => {
  const f = fixture();
  f.store.patchMember(f.worker.id, { role: "집계" });
  const server = await startServer({ config: f.config, store: f.store, bus: new Bus(), orch: f.orch });
  try {
    const input = { id: "cmd-contract", text: "공개된 월별 집계표를 검산해 주세요", intent: "execute", contract };
    const response = await fetch(server.urls[0] + "/api/projects/" + f.project.id + "/messages", { method: "POST",
      headers: { Authorization: "Bearer " + f.config.accessCode, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    const message = await response.json();
    expect(message.targetMemberId).toBe(f.worker.id);
    expect(f.store.getEffectiveContract(message.taskId)).toMatchObject({ rev: 1, sourceMessageId: input.id, authorKind: "owner", scope: contract.scope });
    expect(f.store.listDeliveries(f.project.id).filter(d => d.taskId === message.taskId).map(d => [d.memberId, d.kind, d.refId])).toEqual([[f.worker.id, "user_message", input.id]]);
    expect(f.runner.to(f.worker)).toHaveLength(1);
  } finally { await server.stop(); }
});

test("기존 대화·명시한 총괄과 다른 수신자는 자동 경로로 바꾸지 않는다", async () => {
  const f = existing();
  for (const [id, req, expected] of [
    ["question", { text: "집계가 끝났나요?" }, f.lead],
    ["to-lead", { text: "검산을 조정해줘", intent: "execute" as const, targetMemberId: f.lead.id }, f.lead],
    ["to-second", { text: "남은 검산 기준을 봐 줘", targetMemberId: f.worker2.id }, f.worker2],
  ] as const) {
    const m = await f.orch.sendUserMessage(f.project.id, { id, ...req, taskId: f.task.id });
    expect(f.store.listDeliveries(f.project.id).find(d => d.refId === m.id)?.memberId).toBe(expected.id);
  }
});

test("수신을 기다리는 자동 배정은 보류가 생긴 뒤 입력하지 않고 해제 후 원래 전달을 한 번 진행한다", async () => {
  const f = existing();
  f.runner.busy.add(f.worker.id);
  const m = await f.orch.sendUserMessage(f.project.id, { id: "before-hold", taskId: f.task.id, text: "검산을 진행해 줘", intent: "execute" });
  expect(m.targetMemberId).toBe(f.worker.id);
  f.store.upsertWork({ ...f.card, sec: "hold" });
  f.runner.busy.delete(f.worker.id);
  await f.orch.pump(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(0);
  f.store.upsertWork({ ...f.card, sec: "doing" });
  await f.orch.pump(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(1);
});

test("홈 원문의 정확한 업무 ID·제목은 같은 계약과 배정을 찾고, 같은 제목의 업무 두 개는 고르지 않는다", async () => {
  const f = existing();
  for (const [id, text] of [["id-ref", "업무 #" + f.task.id + " 진행해줘"], ["title-ref", "‘집계 검산’ 업무를 진행해줘"]]) {
    const m = await f.orch.sendUserMessage(f.project.id, { id, text: text!, intent: "execute" });
    expect(m.taskId).toBe(f.task.id);
    expect(m.targetMemberId).toBe(f.worker.id);
  }
  const other = f.store.ensureSourceTask({ projectId: f.project.id, title: "집계 검산", origin: "owner", sourceRef: "different" }).task;
  const m = await f.orch.sendUserMessage(f.project.id, { id: "ambiguous-title", text: "‘집계 검산’ 업무를 진행해줘", intent: "execute" });
  expect([f.task.id, other.id]).not.toContain(m.taskId);
  expect(f.store.listDeliveries(f.project.id).find(d => d.refId === m.id)?.memberId).toBe(f.lead.id);
});

test("단일 담당이 잠들었을 때 새 원문만 정상 세션 재개로 받는다", async () => {
  const f = existing();
  f.store.patchMember(f.worker.id, { status: "asleep", paneId: null });
  const m = await f.orch.sendUserMessage(f.project.id, { id: "sleeping-worker", taskId: f.task.id, text: "검산을 진행해줘", intent: "execute" });
  expect(m.targetMemberId).toBe(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(1);
  expect(f.runner.to(f.lead)).toHaveLength(0);
});

test("이전 업무 재개나 명시적 총괄 조정은 기존 권한·중단을 건드리지 않는다", async () => {
  const f = existing();
  const before = f.store.listTaskContracts(f.task.id);
  f.store.upsertWork({ ...f.card, sec: "hold" });
  for (const [id, text] of [["hold-remains", "정해진 검산을 진행해줘"], ["coordination", "직원들에게 업무를 다시 배정해줘"]]) {
    const m = await f.orch.sendUserMessage(f.project.id, { id, text: text!, taskId: f.task.id, intent: "execute" });
    expect(f.store.listDeliveries(f.project.id).find(d => d.refId === m.id)?.memberId).toBe(f.lead.id);
  }
  expect(f.store.getWork(f.card.id)?.sec).toBe("hold");
  expect(f.store.listTaskContracts(f.task.id)).toEqual(before);
  expect(f.runner.to(f.worker)).toHaveLength(0);
});

test("기존 단일 직원 수신 기록으로만 역할을 입증하고 계약 작성자가 다른 직원이어도 원 담당에게 보낸다", async () => {
  const f = fixture();
  const task = f.store.ensureSourceTask({ projectId: f.project.id, origin: "owner", title: "직원별 검산", sourceRef: "prior-input" }).task;
  const old = f.store.enqueue({ projectId: f.project.id, taskId: task.id, memberId: f.worker.id, kind: "instruction", text: "검산" });
  f.store.markDelivered(old.id);
  f.store.saveTaskContract(task.id, contract, { authorKind: "owner", author: "대표", authorMemberId: null });
  const sent = await f.orch.sendUserMessage(f.project.id, { taskId: task.id, text: "집계의 취소 버튼 집계를 수정해줘", intent: "execute" });
  expect(sent.targetMemberId).toBe(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(1);
});

test("다른 프로젝트의 ID나 상충하는 업무 언급은 새 계약의 역할로 추측하지 않는다", async () => {
  const f = existing();
  const other = f.store.createProject({ name: "별도 프로젝트", cwd: f.project.cwd });
  const foreign = f.store.ensureSourceTask({ projectId: other.id, origin: "owner", title: "다른 검산표", sourceRef: "foreign" }).task;
  const m = await f.orch.sendUserMessage(f.project.id, { id: "foreign-task", text: "#" + foreign.id + " 검산해줘",
    intent: "execute", contract, recipientRole: f.worker.name });
  expect(f.store.listDeliveries(f.project.id).find(d => d.refId === m.id)?.memberId).toBe(f.lead.id);
  expect(f.runner.to(f.worker)).toHaveLength(0);
});

test("실행기가 꺼진 프로젝트에서도 순수 현황은 DB로 답하고 실제 전송이 필요한 요청은 기존 연결 상태를 따른다", async () => {
  const f = fixture();
  f.store.patchProject(f.project.id, { runnerEnabled: false });
  const server = await startServer({ config: f.config, store: f.store, bus: new Bus(), orch: f.orch });
  try {
    const post = (id: string, text: string) => fetch(server.urls[0] + "/api/projects/" + f.project.id + "/messages", {
      method: "POST", headers: { Authorization: "Bearer " + f.config.accessCode, "Content-Type": "application/json" },
      body: JSON.stringify({ id, text, intent: "execute" }),
    });
    const res = await post("offline-status", "지금 다 끝났니?");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ taskId: null, delivery: "delivered" });
    expect((await post("offline-job", "새 업무를 시작해 줘")).status).toBe(409);
    expect(f.store.listDeliveries(f.project.id)).toHaveLength(0);
    expect(f.runner.sent).toHaveLength(0);
  } finally { await server.stop(); }
});

test("일반 입력 안의 인사·질문·중지 문구는 선택된 실행 계약이 있어도 직원에게 새 작업으로 보내지 않는다", async () => {
  const f = existing();
  for (const text of ["고맙습니다", "결과가 왜 이렇게 나왔어", "아직 이 작업 시작하지 마", "Don't run this yet"]) {
    const m = await f.orch.sendUserMessage(f.project.id, { taskId: f.task.id, text, intent: "execute" });
    expect(f.store.listDeliveries(f.project.id).find(d => d.refId === m.id)?.memberId).toBe(f.lead.id);
  }
  expect(f.runner.to(f.worker)).toHaveLength(0);
});

test("대표 원문이 다른 업무로 옮겨지면 이전 업무의 계약으로 준비했던 입력을 멈춘다", async () => {
  const f = existing();
  f.runner.busy.add(f.worker.id);
  const message = await f.orch.sendUserMessage(f.project.id, { taskId: f.task.id, intent: "execute", text: "이번 검산 진행해줘" });
  const other = f.store.ensureSourceTask({ projectId: f.project.id, title: "다른 집계", origin: "owner", sourceRef: "alternate" }).task;
  f.store.saveTaskContract(other.id, { ...contract, goal: "다른 계약의 재무 집계" }, { author: "대표", authorMemberId: null, authorKind: "owner" });
  const move = (from: string, to: string) => f.store.moveRecordTask({ projectId: f.project.id, refType: "message", refId: message.id, from, to, basis: "대표 정정", actor: "대표" });
  expect(move(f.task.id, other.id)).toBe(true);
  f.runner.busy.delete(f.worker.id);
  await f.orch.pump(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(0);
  expect(move(other.id, f.task.id)).toBe(true);
  await f.orch.pump(f.worker.id);
  expect(f.runner.to(f.worker)).toHaveLength(1);
});

test("새 명령의 역할이 아직 팀에 없으면 총괄에게 원문·지정 역할·계약 정의 책임을 한 번 전달한다", async () => {
  const f = fixture(), text = "결산표 오류를 검증해줘";
  const message = await f.orch.sendUserMessage(f.project.id, { id: "plan-for-role", intent: "execute", recipientRole: "외부 기준 검산", text });
  expect(message.body).toBe(text);
  const inputs = f.store.listDeliveries(f.project.id).filter(d => d.refId === message.id);
  expect(inputs).toHaveLength(1);
  expect(inputs[0]?.memberId).toBe(f.lead.id);
  expect(inputs[0]?.text).toContain("외부 기준 검산");
  expect(inputs[0]?.text).toContain("완료 조건");
  expect(f.runner.to(f.worker)).toHaveLength(0);
});

test("유일한 수행 직원도 명시된 역할이 새 계약 범위와 무관하면 총괄이 담당을 정의한다", async () => {
  const f = fixture();
  f.store.patchMember(f.worker.id, { role: "표지 삽화", name: "표지 그림" });
  f.store.patchMember(f.worker2.id, { origin: "manual" });
  const message = await f.orch.sendUserMessage(f.project.id, { text: "월별 집계표 검산을 진행해줘", intent: "execute", contract });
  expect(f.store.listDeliveries(f.project.id).find(d => d.refId === message.id)?.memberId).toBe(f.lead.id);
  expect(f.runner.to(f.worker)).toHaveLength(0);
});
