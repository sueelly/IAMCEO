import { expect, spyOn, test } from "bun:test";
import { checkCompletionReviews, completionReviewAllowsDelivery, synchronizeTaskCompletion } from "../server/task-completion.ts";
import { Store } from "../server/store.ts";
import type { Runner } from "../server/runner/types.ts";
import { Bus } from "../server/bus.ts";
import { fixture, until } from "./fixtures/harness-fixture.ts";

const contract = {
  kind: "other" as const, goal: "담당자가 사용할 인계 내용을 확정한다", scope: "이 업무의 인계 내용",
  inputs: ["대표가 지정한 업무"], outputs: ["담당과 다음 행동을 담은 인계 내용"], constraints: [], exclusions: [],
  acceptance: ["담당자와 다음 행동을 확인할 수 있다"], checks: [],
};
const checks = [{ name: "인계 내용 확인", kind: "other", result: "pass", criterion: 1, evidence: "담당자와 다음 행동을 대조했다" }];

test("검사 통과는 총괄이 일하는 동안에도 후속 업무를 열고 최종 확인은 대기한다", async () => {
  const f = fixture();
  const task = f.orch.saveTask(f.lead, { title: "첫 인계", contract }).task;
  const next = f.orch.saveTask(f.lead, { title: "다음 인계", contract }).task;
  const first = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: task.id, kind: "instruction", text: "첫 인계" });
  f.store.markDelivered(first.id);
  const later = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: next.id, kind: "instruction", text: "다음 인계" });
  f.runner.busy.add(f.lead.id);
  f.store.patchMember(f.lead.id, { status: "working" });
  expect(f.store.taskSequenceBlocker(f.worker.id, next.id)?.taskId).toBe(task.id);
  const report = await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "인계 확인", body: "담당자와 다음 행동을 확인했습니다.", contract_rev: 1, checks });
  expect(report.isError, report.text).toBeUndefined();
  expect(f.store.taskProgress(task.id)).toMatchObject({ stage: "done", finalReview: { status: "pending", contractRev: 1 } });
  expect(f.store.taskSequenceBlocker(f.worker.id, next.id)).toBeNull();
  await f.orch.pump(f.worker.id);
  expect(f.store.requireDelivery(later.id).status).toBe("delivered");
  expect(f.store.listPending(f.lead.id).some(d => d.kind === "report")).toBe(true);
  const audit = f.orch.markTaskStage(f.lead, { taskId: task.id, stage: "done", evidence: "현재 계약과 인계 결과의 담당자·다음 행동을 최종 확인했습니다" });
  expect(audit.progress).toMatchObject({ stage: "done", finalReview: { status: "confirmed" } });
});

test("실패와 미실행 검사는 자동 완료와 후속 해제를 만들지 않는다", async () => {
  const f = fixture(), task = f.orch.saveTask(f.lead, { title: "검증 실패", contract }).task;
  for (const result of ["fail", "not_run"]) {
    const report = await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "검사 결과", body: "검사 결과입니다.", contract_rev: 1, checks: [{ ...checks[0], result }] });
    expect(report.isError).toBe(true);
    expect(f.store.doneMark(task.id)).toBeNull();
  }
});

test("자동 완료 뒤 정정된 실패 보고는 완료를 다시 열고 근거를 보존한다", async () => {
  const f = fixture(), task = f.orch.saveTask(f.lead, { title: "정정 인계", contract }).task;
  const posted = await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "검사 통과", body: "인계 확인", contract_rev: 1, checks });
  expect(posted.isError, posted.text).toBeUndefined();
  const review = f.store.taskProgress(task.id).finalReview!;
  const corrected = await f.tool(f.worker, "post", { task_id: task.id, kind: "막힘", title: "검사 정정", body: "다음 행동이 누락되었습니다.", contract_rev: 1,
    corrects_message_id: review.reportId, checks: [{ ...checks[0], result: "fail" }] });
  expect(corrected.isError, corrected.text).toBeUndefined();
  expect(f.store.doneMark(task.id)).toBeNull();
  expect(f.store.taskProgress(task.id).finalReview?.status).toBe("changes_requested");
  expect(f.store.listStageMarks(task.id).map(m => m.stage)).toEqual(["done", "reopen"]);
});

test("중복 점검은 완료 표시를 추가하지 않고 열린 대표 결재는 완료를 차단한다", async () => {
  const f = fixture(), task = f.orch.saveTask(f.lead, { title: "승인 필요 인계", contract }).task;
  f.store.createDecision({ projectId: f.project.id, taskId: task.id, memberId: f.worker.id, who: f.worker.name, title: "인계 대상을 확정해 주세요" });
  await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "내용 검사", body: "내용 검사를 통과했습니다.", contract_rev: 1, checks });
  f.orch.checkTaskContinuations();
  f.orch.checkTaskContinuations();
  expect(f.store.doneMark(task.id)).toBeNull();
});

test("완료의 현재 계약이 바뀌면 사후 확인으로 옛 완료를 확정할 수 없다", async () => {
  const f = fixture(), task = f.orch.saveTask(f.lead, { title: "새 조건", contract }).task;
  await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "검사", contract_rev: 1, checks });
  f.orch.checkTaskContinuations();
  f.orch.checkTaskContinuations();
  expect(f.store.listStageMarks(task.id).filter(m => m.stage === "done")).toHaveLength(1);
  f.orch.saveTask(f.lead, { taskId: task.id, contract: { ...contract, acceptance: [...contract.acceptance, "대상자의 검토도 받는다"] } });
  expect(f.store.doneMark(task.id)).toBeNull();
  expect(f.store.taskProgress(task.id).finalReview?.status).toBe("changes_requested");
  expect((await f.tool(f.lead, "task_stage", { task_id: task.id, stage: "done", evidence: "옛 검사 재사용" })).isError).toBe(true);
});

test("직원은 총괄 최종 확인을 자기 승인할 수 없다", async () => {
  const f = fixture(), task = f.orch.saveTask(f.lead, { title: "독립 확인", contract }).task;
  await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "검사", contract_rev: 1, checks });
  expect((await f.tool(f.worker, "task_stage", { task_id: task.id, stage: "done", evidence: "자기 확인" })).isError).toBe(true);
  expect(f.store.taskProgress(task.id).finalReview?.status).toBe("pending");
});

test("pending completion audit must recheck a newly opened decision", async()=>{
 const f=fixture(), task=f.orch.saveTask(f.lead,{title:"완료 검수",contract}).task;
 const report=await f.tool(f.worker,"post",{task_id:task.id,kind:"완료",title:"검사",contract_rev:1,checks});
 expect(report.isError).toBeUndefined(); expect(f.store.doneMark(task.id)).not.toBeNull();
 const decision=f.store.createDecision({projectId:f.project.id,taskId:task.id,memberId:f.worker.id,who:f.worker.name,title:"대상자 확정 필요"});
 synchronizeTaskCompletion(f.store,task.id);
 const audit=await f.tool(f.lead,"task_stage",{task_id:task.id,stage:"done",evidence:"다시 확인"});
 expect(audit.isError).toBe(true);
});
test("passing the inherited contract in a child releases the original task", async()=>{
 const f=fixture(),parent=f.orch.saveTask(f.lead,{title:"상위 인계",contract}).task;
 const child=f.orch.saveTask(f.worker,{title:"파생 인계",parentTaskId:parent.id}).task;
 const next=f.orch.saveTask(f.lead,{title:"다음 업무",contract}).task;
 for(const task of [parent,child]){const d=f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:task.id,kind:"instruction",text:task.title});f.store.markDelivered(d.id);}
 f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:next.id,kind:"instruction",text:"다음 업무"});
 const report=await f.tool(f.worker,"post",{task_id:child.id,kind:"완료",title:"상위 계약 전체 조건 통과",contract_rev:1,checks});
 expect(report.isError).toBeUndefined();
 synchronizeTaskCompletion(f.store,child.id);synchronizeTaskCompletion(f.store,parent.id);
 expect(f.store.taskSequenceBlocker(f.worker.id,next.id)).toBeNull();
});
test("a reopened completed descendant invalidates its parent's automatic completion",async()=>{
 const f=fixture(),parent=f.orch.saveTask(f.lead,{title:"상위 인계",contract}).task;
 const child=f.orch.saveTask(f.lead,{title:"파생 인계",parentTaskId:parent.id,contract}).task;
 for(const task of [parent,child]){const d=f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:task.id,kind:"instruction",text:task.title});f.store.markDelivered(d.id);}
 await f.tool(f.worker,"post",{task_id:child.id,kind:"완료",title:"파생 확인",contract_rev:1,checks});
 await f.tool(f.worker,"post",{task_id:parent.id,kind:"완료",title:"전체 확인",contract_rev:1,checks});
 expect(f.store.doneMark(parent.id)).not.toBeNull();
 f.orch.markTaskStage(f.lead,{taskId:child.id,stage:"reopen",evidence:"미완료 조건 발견"});
 synchronizeTaskCompletion(f.store,parent.id);
 expect(f.store.doneMark(parent.id)).toBeNull();
});


test("미지원 실행 근거는 자동 완료하지 않는다", async () => {
  const f = fixture(), task = f.orch.saveTask(f.lead, { title: "지원되지 않는 검사", contract }).task;
  await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "검사", contract_rev: 1, checks });
  const review = f.store.taskProgress(task.id).finalReview!;
  f.store.db.query("UPDATE report_harness SET evidence_status='unsupported' WHERE message_id=?").run(review.reportId);
  synchronizeTaskCompletion(f.store, task.id);
  expect(f.store.doneMark(task.id)).toBeNull();
});

test("미확인 최종 검수는 재시작 뒤에도 한 건으로 다시 연결하고 검수가 끝나면 보내지 않는다", async () => {
  const f = fixture(), task = f.orch.saveTask(f.lead, { title: "최종 검수 복원", contract }).task;
  const reviewer = f.store.ensureFinalReviewer(f.project.id)!;
  await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "검사", contract_rev: 1, checks });
  const pending = checkCompletionReviews(f.store, Date.now() + 60_000, 30_000);
  expect(pending).toHaveLength(1);
  expect(pending[0]?.memberId).toBe(reviewer.id);
  expect(checkCompletionReviews(new Store(f.store.db, new Bus()), Date.now() + 120_000, 30_000)).toHaveLength(0);
  expect(f.store.listPending(reviewer.id).filter(d => d.text.includes("비동기 최종 확인"))).toHaveLength(1);
  const reportId = f.store.taskProgress(task.id).finalReview!.reportId;
  expect((await f.tool(reviewer, "task_review_evidence", { task_id: task.id, report_id: reportId })).isError).toBeUndefined();
  const audit = await f.tool(reviewer, "task_review", { task_id: task.id, report_id: reportId, result: "confirmed", evidence: "계약과 결과를 대조했습니다" });
  expect(audit.isError, audit.text).toBeUndefined();
  expect(f.store.taskProgress(task.id).finalReview?.status).toBe("confirmed");
  expect(f.store.requireDelivery(pending[0]!.id).status).toBe("failed");
});

test("refused final audit must persist revocation and retire its queued reminder atomically",async()=>{
 const f=fixture(),task=f.orch.saveTask(f.lead,{title:"인계",contract}).task;
 const reviewer=f.store.ensureFinalReviewer(f.project.id)!;
 await f.tool(f.worker,"post",{task_id:task.id,kind:"완료",title:"검사",contract_rev:1,checks});
 // Keep the conductor busy so reminder generation cannot physically write it.
 f.runner.busy.add(f.lead.id);
 const reports=f.store.listPending(f.lead.id).filter(d=>d.kind==="report");
 for(const report of reports) f.store.markDelivered(report.id);
 const reminders=checkCompletionReviews(f.store,Date.now()+60_000,30_000);
 expect(reminders).toHaveLength(1);
 f.store.createDecision({projectId:f.project.id,taskId:task.id,memberId:f.worker.id,who:f.worker.name,title:"새 차단 결재"});
 const review=f.store.taskProgress(task.id).finalReview!;
 const refused=await f.tool(reviewer,"task_review",{task_id:task.id,report_id:review.reportId,result:"confirmed",evidence:"최종 검수"});
 expect(refused.isError).toBe(true);
 expect(f.store.doneMark(task.id)).toBeNull();
 expect(completionReviewAllowsDelivery(f.store,reminders[0]!)).toBe(false);
});
test("unapproved unscheduled child candidate does not become a required execution obligation",async()=>{
 const f=fixture(),task=f.orch.saveTask(f.lead,{title:"승인된 인계",contract}).task;
 const candidate=f.orch.saveTask(f.lead,{title:"별도 확정이 필요한 후보",parentTaskId:task.id}).task;
 const next=f.orch.saveTask(f.lead,{title:"다음 승인 업무",contract}).task;
 const first=f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:task.id,kind:"instruction",text:"승인된 인계"});f.store.markDelivered(first.id);
 f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:next.id,kind:"instruction",text:"다음 승인 업무"});
 const report=await f.tool(f.worker,"post",{task_id:task.id,kind:"완료",title:"현재 계약 전체 충족",contract_rev:1,checks});
 expect(report.isError).toBeUndefined();
 synchronizeTaskCompletion(f.store,task.id);
 expect(f.store.doneMark(task.id)).not.toBeNull();
});
test("child contract changes invalidate the completed parent in the same save event",async()=>{
 const f=fixture(),parent=f.orch.saveTask(f.lead,{title:"부모",contract}).task;
 const child=f.orch.saveTask(f.lead,{title:"자식",parentTaskId:parent.id,contract}).task;
 const next=f.orch.saveTask(f.lead,{title:"후속",contract}).task;
 const initial=f.store.enqueue({projectId:f.project.id,memberId:f.worker.id,taskId:parent.id,kind:"instruction",text:"부모"});f.store.markDelivered(initial.id);
 const childInput=f.store.enqueue({projectId:f.project.id,memberId:f.worker2.id,taskId:child.id,kind:"instruction",text:"자식"});f.store.markDelivered(childInput.id);
 await f.tool(f.worker2,"post",{task_id:child.id,kind:"완료",title:"자식 통과",contract_rev:1,checks});
 await f.tool(f.worker,"post",{task_id:parent.id,kind:"완료",title:"부모 통과",contract_rev:1,checks});
 expect(f.store.doneMark(parent.id)).not.toBeNull();
 f.orch.saveTask(f.lead,{taskId:child.id,contract:{...contract,acceptance:[...contract.acceptance,"추가 승인 확인"]}});
 expect(f.store.doneMark(parent.id)).toBeNull();
});

test("a committed blocker revokes only its task without waiting for a periodic check", async () => {
  const f = fixture();
  const tasks: { id: string }[] = [];
  for (const title of ["변경할 인계", "별도 인계"]) {
    const task = f.orch.saveTask(f.lead, { title, contract }).task;
    const report = await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "확인", contract_rev: 1, checks });
    expect(report.isError, report.text).toBeUndefined();
    tasks.push(task);
  }
  // Let initial report events settle, then open a blocker while no scheduler is running.
  await until("초기 변경 처리", () => !f.store.db.query("SELECT 1 FROM completion_changes LIMIT 1").get());
  const evidence = spyOn(f.store, "hasUnsettledTaskInput");
  try {
    expect(() => f.store.transaction(() => {
      f.store.createDecision({ projectId: f.project.id, taskId: tasks[1]!.id, who: "대표", title: "취소할 결재" });
      throw new Error("rollback");
    })).toThrow("rollback");
    f.store.createDecision({ projectId: f.project.id, taskId: tasks[0]!.id, who: "대표", title: "새 차단 결재" });
    await until("변경된 완료 판정", () => f.store.doneMark(tasks[0]!.id) === null);
    expect(f.store.doneMark(tasks[1]!.id)).not.toBeNull();
    expect(evidence.mock.calls.some(([taskId]) => taskId === tasks[1]!.id)).toBe(false);
  } finally { evidence.mockRestore(); }
});

test("periodic checks do not revalidate unchanged completion evidence", async () => {
  const f = fixture();
  const task = f.orch.saveTask(f.lead, { title: "완료 근거", contract }).task;
  await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "확인", contract_rev: 1, checks });
  expect(f.store.doneMark(task.id)).not.toBeNull();
  f.orch.checkTaskContinuations();
  const evidence = spyOn(f.store, "completionEvidence");
  try {
    f.orch.checkTaskContinuations();
    f.orch.checkTaskContinuations();
    expect(evidence.mock.calls).toHaveLength(0);
  } finally { evidence.mockRestore(); }
});

test("an inferred approval assignment expires after fourteen days even without a new task event", async () => {
  const f = fixture(), task = f.orch.saveTask(f.lead, { title: "승인 귀속 만료", contract }).task;
  const assigned = f.store.enqueue({ projectId: f.project.id, memberId: f.worker2.id, taskId: task.id,
    kind: "instruction", text: "검증" });
  f.store.markDelivered(assigned.id);
  const now = Date.now(), received = new Date(now - 14 * 86400000 + 60000).toISOString();
  f.store.db.query("UPDATE deliveries SET created_at=? WHERE id=?").run(received, assigned.id);
  f.store.patchMember(f.worker2.id, { status: "blocked", blockedReason: "permission" });
  const posted = await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "확인", contract_rev: 1, checks });
  expect(posted.isError, posted.text).toBeUndefined();
  f.orch.checkTaskContinuations(now);
  expect(f.store.doneMark(task.id)).toBeNull();
  const clock = spyOn(Date, "now").mockReturnValue(now + 61000);
  try {
    f.orch.checkTaskContinuations();
    expect(f.store.doneMark(task.id)).not.toBeNull();
    expect(f.store.requireMember(f.worker2.id).status).toBe("blocked");
  } finally { clock.mockRestore(); }
});

test("a busy worker's unchanged queue is classified once per pump", async () => {
  const f = fixture(), task = f.orch.saveTask(f.lead, { title: "차례 대기", contract }).task;
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: task.id,
    kind: "instruction", text: "다음 차례" });
  f.runner.busy.add(f.worker.id);
  const sequence = spyOn(f.store, "taskSequenceSnapshot");
  try {
    await f.orch.pump(f.worker.id);
    expect(f.store.requireDelivery(delivery.id).status).toBe("queued");
    expect(sequence.mock.calls.filter(([, member]) => member === f.worker.id)).toHaveLength(1);
  } finally { sequence.mockRestore(); }
});

test("one maintenance tick gives HTTP a turn between distinct queued workers", async () => {
  const f = fixture(), workers = [f.worker, f.worker2];
  for (const worker of workers) {
    f.runner.busy.add(worker.id);
    f.store.enqueue({ projectId: f.project.id, memberId: worker.id, kind: "system", text: "대기" });
  }
  let yielded = false;
  const seen: boolean[] = [];
  const run = f.orch.pump.bind(f.orch);
  const pump = spyOn(f.orch, "pump").mockImplementation(id => {
    if (workers.some(worker => worker.id === id)) {
      if (!seen.length) setTimeout(() => { yielded = true; }, 0);
      seen.push(yielded);
    }
    return run(id);
  });
  try {
    await (f.orch as unknown as { onTick(): Promise<void> }).onTick();
    await until("두 직원의 대기열 확인", () => seen.length >= 2);
    expect(seen).toEqual([false, true]);
  } finally { pump.mockRestore(); }
});

test("주기 점검은 수신 직원을 찾기 위해 전체 대기열의 본문을 읽지 않는다", async () => {
  const f = fixture();
  f.runner.busy.add(f.worker.id);
  f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "system", text: "대기" });
  const read = spyOn(f.store, "listUndelivered");
  const pump = spyOn(f.orch, "pump");
  try {
    await (f.orch as unknown as { onTick(): Promise<void> }).onTick();
    expect(pump.mock.calls.some(([id]) => id === f.worker.id)).toBe(true);
    expect(read.mock.calls.filter(([project]) => project === undefined)).toHaveLength(0);
  } finally { read.mockRestore(); pump.mockRestore(); }
});

test("업무 없는 직원 알림은 실제 쓰기 직전까지 업무 순서를 조회하지 않는다", async () => {
  const f = fixture(), send = f.runner.send.bind(f.runner);
  const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, kind: "system", text: "실행기 알림" });
  expect(delivery.taskId).toBeNull();
  const sequence = spyOn(f.store, "taskSequenceSnapshot");
  const transport = spyOn(f.runner as Runner, "send").mockImplementation(async (member, text, options) => {
    expect(options.beforeWrite?.()).toBe(true);
    return send(member, text);
  });
  try {
    await f.orch.pump(f.worker.id);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(f.store.requireDelivery(delivery.id).status).toBe("delivered");
    expect(sequence).toHaveBeenCalledTimes(0);
  } finally { sequence.mockRestore(); transport.mockRestore(); }
});
