import { expect, test } from "bun:test";
import { checkCompletionReviews, completionReviewAllowsDelivery } from "../server/task-completion.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

const contract = {
  kind: "other" as const, goal: "산출물의 담당과 인계 내용을 확인한다", scope: "확정한 산출물",
  inputs: ["요청 원문"], outputs: ["확인한 산출물"], constraints: [], exclusions: [],
  acceptance: ["산출물의 담당과 다음 행동을 확인할 수 있다"], checks: [],
};
const checks = [{ name: "인계 확인", kind: "other", result: "pass", criterion: 1, evidence: "산출물의 담당과 다음 행동을 대조했다" }];

async function completed(f: ReturnType<typeof fixture>, title: string) {
  const task = f.orch.saveTask(f.lead, { title, contract }).task;
  const result = await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title, contract_rev: 1, checks });
  expect(result.isError, result.text).toBeUndefined();
  const review = f.store.taskProgress(task.id).finalReview!;
  expect(review.status).toBe("pending");
  return { task, reportId: review.reportId };
}

function readyReviews(f: ReturnType<typeof fixture>) {
  f.runner.busy.add(f.lead.id);
  for (const delivery of f.store.listPending(f.lead.id).filter(item => item.kind === "report")) f.store.markDelivered(delivery.id);
  return checkCompletionReviews(f.store, Date.now() + 60_000, 30_000);
}

test("one project reminder covers several completions and keeps its remaining reviews after a partial decision", async () => {
  const f = fixture();
  const first = await completed(f, "첫 인계");
  const second = await completed(f, "둘째 인계");
  const [notice, ...otherNotices] = readyReviews(f);
  expect(otherNotices).toHaveLength(0);
  expect(notice).toMatchObject({ projectId: f.project.id, memberId: f.lead.id, taskId: null });
  expect(notice!.text).toContain("completion_reviews");
  expect(notice!.text).not.toContain("task_stage(reopen");
  await completed(f, "셋째 인계");
  expect(readyReviews(f)).toHaveLength(0);
  f.orch.markTaskStage(f.lead, { taskId: first.task.id, stage: "done", evidence: "첫 인계의 산출물과 결과를 독립 대조" });
  expect(completionReviewAllowsDelivery(f.store, notice!)).toBe(true);
  expect(f.store.requireDelivery(notice!.id).status).toBe("queued");
  f.orch.markTaskStage(f.lead, { taskId: second.task.id, stage: "done", evidence: "둘째 인계의 산출물과 결과를 독립 대조" });
  expect(completionReviewAllowsDelivery(f.store, notice!)).toBe(false);
  expect(f.store.requireDelivery(notice!.id).status).toBe("failed");
  expect(readyReviews(f)).toHaveLength(1);
});

test("the conductor can page through current review evidence from only their project", async () => {
  const f = fixture();
  const first = await completed(f, "첫 검수 대상");
  const second = await completed(f, "둘째 검수 대상");
  const foreign = f.store.createProject({ name: "다른 프로젝트", cwd: f.project.cwd });
  const otherLead = f.store.createMember({ projectId: foreign.id, handle: "lead", name: "다른 총괄", kind: "conductor", origin: "runner", cwd: f.project.cwd });
  const otherWorker = f.store.createMember({ projectId: foreign.id, handle: "worker", name: "다른 작업자", kind: "worker", origin: "manual", cwd: f.project.cwd });
  const otherTask = f.orch.saveTask(otherLead, { title: "다른 프로젝트 자료", contract }).task;
  const foreignPost = await f.tool(otherWorker, "post", { task_id: otherTask.id, kind: "완료", title: otherTask.title, contract_rev: 1, checks });
  expect(foreignPost.isError, foreignPost.text).toBeUndefined();
  const read = await f.tool(f.lead, "completion_reviews", { limit: 1 });
  expect(read.isError, read.text).toBeUndefined();
  const page = JSON.parse(read.text);
  expect(page.items).toMatchObject([{ taskId: first.task.id, reportId: first.reportId, authorId: f.worker.id, contractRev: 1 }]);
  const next = await f.tool(f.lead, "completion_reviews", { limit: 1, after: page.next });
  expect(JSON.parse(next.text)).toMatchObject({ items: [{ taskId: second.task.id, reportId: second.reportId }], next: null });
  const owned = await f.tool(otherLead, "completion_reviews", {});
  expect(JSON.parse(owned.text).items).toMatchObject([{ taskId: otherTask.id }]);
  expect((await f.tool(f.worker, "completion_reviews", {})).isError).toBe(true);
});

test("an independent finding creates one stand-alone repair and leaves completion and next work intact", async () => {
  const f = fixture();
  const source = await completed(f, "완료한 산출물");
  const next = f.orch.saveTask(f.lead, { title: "원 작업자의 다음 업무", contract }).task;
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: next.id, text: "예정한 다음 업무를 진행" }, f.lead);
  const audit = f.orch.saveTask(f.lead, { title: "사후 검수", contract }).task;
  await f.orch.assign(f.project.id, f.worker2.handle, { taskId: audit.id, text: "완료 보고의 산출물과 근거를 대조" }, f.lead);
  const report = await f.tool(f.worker2, "post", { task_id: audit.id, kind: "진행", title: "추가 결함 재현",
    body: "다른 입력에서 값이 사라진다", about_report_id: source.reportId });
  expect(report.isError, report.text).toBeUndefined();
  const finding = f.store.listMessagesAbout(f.project.id, source.reportId).at(-1)!;
  const args = { kind: "review_repair", task_id: source.task.id, completion_report_id: source.reportId, report_id: finding.id,
    title: "다른 입력의 값 보존 수정", detail: "다른 입력의 값이 보존되는 회귀 검사를 추가한다" };
  const first = await f.tool(f.lead, "task_followup", args);
  expect(first.isError, first.text).toBeUndefined();
  const second = await f.tool(f.lead, "task_followup", args);
  const [work] = f.store.listWork(f.project.id);
  expect(second.text).toBe(first.text);
  expect(f.store.listWork(f.project.id)).toHaveLength(1);
  expect(f.store.requireTask(work!.taskId!).parentTaskId).toBeNull();
  expect(work!.detail).toContain(source.reportId);
  expect(work!.detail).toContain(finding.id);
  expect(f.store.taskProgress(source.task.id)).toMatchObject({ stage: "done", finalReview: { status: "pending" } });
  expect(f.store.getTaskContract(source.task.id)?.rev).toBe(1);
  expect(f.store.listTaskDeliveries(next.id).find(d => d.kind === "instruction")?.status).toBe("delivered");
});

test("a self-review or a finding about invalidated completion cannot create an independent repair", async () => {
  const f = fixture();
  const source = await completed(f, "검수할 산출물");
  const audit = f.orch.saveTask(f.lead, { title: "검수 기록" }).task;
  const find = (memberId: string) => f.store.createMessage({ projectId: f.project.id, taskId: audit.id, kind: "알림", who: "검수자",
    memberId, title: "추가 결함 주장", body: "현재 판 확인", aboutMessageId: source.reportId });
  const args = { kind: "review_repair", task_id: source.task.id, completion_report_id: source.reportId, title: "추가 결함 수정", detail: "재현 확인" };
  expect((await f.tool(f.lead, "task_followup", { ...args, report_id: find(f.worker.id).id })).isError).toBe(true);
  f.orch.saveTask(f.lead, { taskId: source.task.id, contract: { ...contract, acceptance: [...contract.acceptance, "새 조건을 확인한다"] } });
  expect((await f.tool(f.lead, "task_followup", { ...args, report_id: find(f.worker2.id).id })).isError).toBe(true);
  expect(f.store.listWork(f.project.id)).toHaveLength(0);
  expect(f.store.doneMark(source.task.id)).toBeNull();
  expect(JSON.parse((await f.tool(f.lead, "completion_reviews", {})).text).items).toHaveLength(0);
});
