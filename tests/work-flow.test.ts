// 업무 중심 체험판의 규칙(A2~A7). 체험판 DB(임시 폴더)와 테스트 실행기만 쓴다. 운영 DB·core·CLI·네트워크 없음.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkError, WorkService } from "../server/work.ts";
import type { WorkTask } from "../shared/work-types.ts";

const open: WorkService[] = [];
afterEach(() => { for (const s of open.splice(0)) { try { s.close(); } catch { /* 이미 닫힘 */ } } });

function make(dbPath = join(mkdtempSync(join(tmpdir(), "work-flow-")), "w.db")) {
  const s = new WorkService({ dbPath, delayMs: 5 });
  open.push(s);
  return { s, dbPath };
}
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error("시간 안에 조건이 맞지 않았습니다"); await Bun.sleep(5); }
}
const byTitle = (s: WorkService, title: string): WorkTask => s.state().tasks.find((t) => t.title === title)!;
const settled = (s: WorkService) => until(() => s.runner.pending === 0 && !(s.db.query("SELECT 1 FROM run_inputs i JOIN runs r ON r.id = i.run_id JOIN tasks t ON t.id = r.task_id WHERE i.state = 'pending' AND t.status != 'waiting_dep' AND r.status = 'active' LIMIT 1").get()));

describe("A2 접수·탐색", () => {
  test("다섯 업무가 직원 선택 없이 독립 ID·대화를 갖고, 다시 열어도 그대로다", async () => {
    const { s, dbPath } = make();
    await settled(s);
    const st = s.state();
    expect(st.tasks).toHaveLength(5);
    expect(new Set(st.tasks.map((t) => t.id)).size).toBe(5);
    expect(st.tasks.filter((t) => t.projectId === "proj_trial")).toHaveLength(3);
    expect(st.tasks.filter((t) => t.projectId === "proj_hq")).toHaveLength(2);
    expect(st.tasks.filter((t) => t.goalId === "goal_launch")).toHaveLength(3);
    for (const t of st.tasks) expect(s.detail(t.id).messages.every((m) => m.taskId === t.id)).toBe(true);
    // 새 업무: 역할·모델을 고르지 않아도 접수된다(제목으로 역할 자동).
    const created = s.createTask({ title: "협력사 자료 조사", instruction: "후보 세 곳을 찾아 주세요", clientId: "c-new" });
    expect(created.roleId).toBe("role_research");
    expect(created.projectId).toBe("proj_hq");
    expect(s.createTask({ title: "협력사 자료 조사", clientId: "c-new" }).id).toBe(created.id); // 같은 접수 재시도는 하나
    await settled(s);
    const before = s.state();
    const msgCount = s.detail(created.id).messages.length;
    s.close(); open.pop();
    const again = new WorkService({ dbPath, delayMs: 5 }); open.push(again);
    const after = again.state();
    expect(after.tasks.map((t) => [t.id, t.status])).toEqual(before.tasks.map((t) => [t.id, t.status]));
    expect(again.detail(created.id).messages.length).toBe(msgCount);
    expect(after.files.length).toBe(before.files.length);
  });
});

describe("A3 후속 지시는 보낼 때의 업무·실행에 고정된다", () => {
  test("느린 응답 중 다른 업무에 보내도 결과가 섞이지 않고, 같은 전송 ID는 한 번만 받는다", async () => {
    const { s } = make();
    await settled(s);
    const structure = byTitle(s, "대화 구조 검토"), trip = byTitle(s, "출장 동선 조사");
    const m1 = s.send(structure.id, { clientId: "c1", text: "둘째 안을 보강해 주세요. 천천히" });
    s.send(trip.id, { clientId: "c2", text: "숙소도 같이 봐 주세요" });
    expect(s.send(structure.id, { clientId: "c1", text: "둘째 안을 보강해 주세요. 천천히" }).id).toBe(m1.id);
    expect(() => s.send(trip.id, { clientId: "c1", text: "다른 업무에 같은 ID" })).toThrow(WorkError);
    await settled(s);
    const sd = s.detail(structure.id), td = s.detail(trip.id);
    expect(sd.messages.filter((m) => m.clientId === "c1")).toHaveLength(1);
    expect(sd.files.map((f) => f.title)).toContain("대화 구조 검토 — 둘째 안 보강");
    expect(td.files.map((f) => f.title)).not.toContain("대화 구조 검토 — 둘째 안 보강");
    expect(sd.decisions.map((d) => d.title)).toContain("둘째 안 보강본으로 확정할까요?");
    expect(td.decisions).toHaveLength(0);
    expect(td.messages.some((m) => m.body.includes("보강"))).toBe(false);
    // 입력은 보낼 때의 실행에 들어갔다.
    expect(sd.runs.at(-1)!.inputs.map((i) => i.text)).toContain("둘째 안을 보강해 주세요. 천천히");
    expect(td.runs.at(-1)!.inputs.map((i) => i.text)).not.toContain("둘째 안을 보강해 주세요. 천천히");
  });
});

describe("A4 내 차례·자료", () => {
  test("결재 답은 정확한 안건에만 한 번 적용되고, 결과 자료는 출처 업무로 돌아간다", async () => {
    const { s } = make();
    await settled(s);
    const quote = byTitle(s, "견적 비교");
    const d = s.state().decisions.find((x) => x.taskId === quote.id && x.status === "open")!;
    expect(d).toBeTruthy();
    const a1 = s.answer(d.id, { operationId: "op-1", optionKey: "price" });
    expect(s.answer(d.id, { operationId: "op-1", optionKey: "price" })).toEqual(a1);
    expect(() => s.answer(d.id, { operationId: "op-2", optionKey: "lead" })).toThrow("이미 답한 결재");
    await settled(s);
    const qd = s.detail(quote.id);
    expect(qd.runs.at(-1)!.inputs.filter((i) => i.source === "answer").map((i) => i.text)).toEqual(["가격 우선"]);
    const file = qd.files.find((f) => f.title.startsWith("견적 비교표"))!;
    expect(file.taskId).toBe(quote.id);
    expect(s.file(file.id).taskId).toBe(quote.id);
    // 다른 업무 실행에는 답이 들어가지 않았다.
    for (const t of s.state().tasks.filter((t) => t.id !== quote.id)) expect(s.detail(t.id).runs.flatMap((r) => r.inputs).some((i) => i.source === "answer")).toBe(false);
  });
});

describe("A5 같은 역할의 두 업무는 다른 실행 문맥을 쓴다", () => {
  test("실행 ID·입력 기록이 다르고 상대 업무의 식별 문구가 입력·응답에 섞이지 않는다", async () => {
    const { s } = make();
    await settled(s);
    const structure = byTitle(s, "대화 구조 검토"), trip = byTitle(s, "출장 동선 조사");
    expect(structure.roleId).toBe(trip.roleId);
    expect(structure.activeRunId).not.toBe(trip.activeRunId);
    s.send(structure.id, { text: "추가 확인: 식별:파랑" });
    s.send(trip.id, { text: "추가 확인: 식별:노랑" });
    await settled(s);
    const sIn = s.runner.received.get(structure.activeRunId!)!.join("\n"), tIn = s.runner.received.get(trip.activeRunId!)!.join("\n");
    expect(sIn).toContain("식별:파랑"); expect(sIn).toContain("식별:구조검토");
    expect(sIn).not.toContain("식별:노랑"); expect(sIn).not.toContain("식별:출장동선");
    expect(tIn).toContain("식별:노랑"); expect(tIn).not.toContain("식별:파랑"); expect(tIn).not.toContain("식별:구조검토");
    const sReplies = s.detail(structure.id).messages.filter((m) => m.kind === "reply").map((m) => m.body).join("\n");
    const tReplies = s.detail(trip.id).messages.filter((m) => m.kind === "reply").map((m) => m.body).join("\n");
    expect(sReplies).toContain("파랑"); expect(sReplies).not.toContain("노랑");
    expect(tReplies).toContain("노랑"); expect(tReplies).not.toContain("파랑");
    // DB 의 입력 기록도 실행별로 따로다.
    const sDb = s.inputsOf(structure.activeRunId!).map((i) => i.text).join("\n");
    expect(sDb).not.toContain("노랑");
  });
});

describe("A6 담당·모델 교체와 재개", () => {
  test("열린 결재·자료가 그대로이고, 새 실행에는 이 업무 인계만 들어가며, 옛 실행의 늦은 결과는 반영되지 않는다", async () => {
    const { s } = make();
    await settled(s);
    const quote = byTitle(s, "견적 비교");
    const oldRun = quote.activeRunId!;
    const openD = s.state().decisions.find((d) => d.taskId === quote.id && d.status === "open")!;
    s.setRole(quote.id, "role_research");
    s.setModel(quote.id, "테스트-정밀");
    await settled(s);
    const after = s.detail(quote.id);
    expect(after.task.id).toBe(quote.id);
    expect(after.runs.map((r) => r.reason)).toEqual(["start", "role_change", "model_change"]);
    expect(after.runs.filter((r) => r.status === "active")).toHaveLength(1);
    const active = after.runs.at(-1)!;
    expect(active.model).toBe("테스트-정밀");
    const handoff = active.inputs.find((i) => i.source === "handoff")!.text;
    expect(handoff).toContain("견적 비교"); expect(handoff).toContain("견적 조건을 골라 주세요");
    for (const other of ["연동 구현", "대화 구조 검토", "출장 동선", "소개 글"]) expect(handoff).not.toContain(other);
    expect(active.inputs.every((i) => !i.text.includes("식별:"))).toBe(true);
    expect(after.decisions.find((d) => d.id === openD.id)!.status).toBe("open");
    // 옛 실행의 늦은 결과
    const filesBefore = after.files.length;
    s.onOutput({ runId: oldRun, taskId: quote.id, inputId: "in_none", replies: ["늦은 응답"], file: { title: "옛 실행 자료", content: "x" } });
    const late = s.detail(quote.id);
    expect(late.files.length).toBe(filesBefore);
    expect(late.messages.at(-1)!.kind).toBe("late");
    expect(late.task.activeRunId).toBe(active.id);
    // 답은 새 실행으로 간다.
    s.answer(openD.id, { operationId: "op-a6", optionKey: "balance" });
    await settled(s);
    expect(s.inputsOf(active.id).some((i) => i.source === "answer" && i.text === "균형")).toBe(true);
    expect(s.inputsOf(oldRun).some((i) => i.source === "answer")).toBe(false);
    // 완료 → 재개: 같은 업무에 이력이 이어진다.
    s.complete(quote.id);
    expect(s.detail(quote.id).task.status).toBe("done");
    s.resume(quote.id, "납기도 다시 봐 주세요");
    await settled(s);
    const resumed = s.detail(quote.id);
    expect(resumed.task.id).toBe(quote.id);
    expect(resumed.runs.at(-1)!.reason).toBe("resume");
    expect(resumed.messages.length).toBeGreaterThan(late.messages.length);
    expect(resumed.decisions.find((d) => d.id === openD.id)!.answer).toBe("균형");
  });
});

describe("A7 협업·종합", () => {
  test("선행 결과를 기다렸다가 이어 가고, 업무 사이 질의·답이 기록되며 총괄 종합에 선후가 보인다", async () => {
    const { s } = make();
    await settled(s);
    const intro = byTitle(s, "소개 글 작성"), structure = byTitle(s, "대화 구조 검토"), integration = byTitle(s, "연동 구현");
    expect(intro.status).toBe("waiting_dep");
    expect(() => s.complete(intro.id)).toThrow("선행");
    expect(s.state().coordination.some((n) => n.kind === "waiting" && n.taskIds.includes(intro.id))).toBe(true);
    expect(s.runner.received.get(intro.activeRunId!)).toBeUndefined(); // 기다리는 동안 실행기에 보내지 않는다
    s.complete(structure.id);
    await until(() => s.detail(intro.id).files.some((f) => f.title === "소개 글 초안"));
    await settled(s);
    const id = s.detail(intro.id), ig = s.detail(integration.id);
    expect(id.task.status).not.toBe("waiting_dep");
    expect(id.messages.some((m) => m.kind === "collab_q" && m.peerTaskId === integration.id)).toBe(true);
    expect(id.messages.some((m) => m.kind === "collab_a" && m.peerTaskId === integration.id)).toBe(true);
    expect(ig.messages.some((m) => m.kind === "collab_q" && m.peerTaskId === intro.id)).toBe(true);
    // 질문만 상대 실행에 들어갔고, 묻는 쪽의 지시 원문은 넘어가지 않았다.
    const igInputs = ig.runs.at(-1)!.inputs;
    expect(igInputs.some((i) => i.source === "collab_question")).toBe(true);
    expect(igInputs.some((i) => i.text.includes("소개 글 초안을 써"))).toBe(false);
    // 주담당 결과(자료)와 협업 근거(collab 메시지)가 구분된다.
    expect(id.files.find((f) => f.title === "소개 글 초안")!.runId).toBe(id.task.activeRunId!);
    expect(s.state().coordination.some((n) => n.kind === "order" && n.text.includes("선행 결과 도착"))).toBe(true);
  });
});
