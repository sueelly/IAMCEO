import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";

const commit = "a".repeat(40);
const different = "b".repeat(40);
const contract = {
  kind: "other" as const, goal: "검수할 변경을 인계한다", scope: "이 작업 브랜치",
  inputs: ["대표가 지정한 변경"], outputs: ["검증한 작업 브랜치"], constraints: [], exclusions: [],
  acceptance: ["변경의 검증 결과가 있다"], checks: [],
};
const checks = [{ name: "검증 결과 확인", kind: "other", result: "pass", criterion: 1, evidence: "검증했습니다" }];

async function readyForReview() {
  const f = fixture();
  const source = f.orch.saveTask(f.lead, { title: "설정 복구 보완", branch: "fix/settings-retry", contract }).task;
  const result = await f.tool(f.worker, "post", { task_id: source.id, kind: "완료", title: "설정 복구 검증", contract_rev: 1, artifact_commit: commit, checks });
  expect(result.isError, result.text).toBeUndefined();
  expect(f.store.taskProgress(source.id).finalReview?.status).toBe("pending");
  const confirm = () => f.tool(f.lead, "task_stage", { task_id: source.id, stage: "done", evidence: "변경과 검사 근거를 확인했습니다", reviewed_commit: commit });
  const integration = (head = commit) => f.tool(f.lead, "task_followup", { task_id: source.id, kind: "integration", reviewed_commit: head });
  return { ...f, source, confirm, integration };
}

test("only a current final review for the exact commit creates one linked integration task", async () => {
  const f = await readyForReview();
  expect((await f.integration()).isError).toBe(true);
  expect((await f.confirm()).isError).toBeUndefined();
  expect(f.store.listWork(f.project.id).filter(w => w.sec === "next")).toHaveLength(1);
  expect((await f.integration(different)).isError).toBe(true);
  const queued = await f.integration();
  expect(queued.isError, queued.text).toBeUndefined();
  const repeated = await f.integration();
  expect(repeated.isError).toBeUndefined();
  const next = f.store.listWork(f.project.id).filter(w => w.sec === "next");
  expect(next).toHaveLength(1);
  expect(next[0]?.detail).toContain(commit);
  expect(next[0]?.detail).toContain("fix/settings-retry");
  expect(next[0]?.detail).toContain("origin/main");
  expect(next[0]?.detail).toContain("브랜치");
});

test("a reported pre-merge problem queues one repair and withdraws the original review", async () => {
  const f = await readyForReview();
  expect((await f.confirm()).isError).toBeUndefined();
  expect((await f.integration()).isError).toBeUndefined();
  const issue = await f.orch.recordPost(f.lead, { taskId: f.source.id, kind: "알림", title: "설정 재시도에서 데이터 누락 재현", body: "설정 재시도에서 두 번째 저장이 누락됩니다." });
  const args = { task_id: f.source.id, kind: "repair", report_id: issue.id, title: "설정 재시도의 두 번째 저장 복구", detail: "두 번째 저장의 회귀 검사와 수정만 수행합니다." };
  expect((await f.tool(f.lead, "task_followup", args)).isError).toBeUndefined();
  expect((await f.tool(f.lead, "task_followup", args)).isError).toBeUndefined();
  expect(f.store.taskProgress(f.source.id).finalReview?.status).toBe("changes_requested");
  const work = f.store.listWork(f.project.id);
  expect(work.filter(w => w.sec === "next").map(w => w.title)).toEqual([args.title]);
  expect(work.filter(w => w.sec === "hold")).toHaveLength(1);
  expect((await f.integration()).isError).toBe(true);
});

test("a post-merge repair preserves the original final review", async () => {
  const f = await readyForReview();
  expect((await f.confirm()).isError).toBeUndefined();
  expect((await f.integration()).isError).toBeUndefined();
  const arbitrary = await f.tool(f.lead, "task_stage", { task_id: f.source.id, stage: "merged", evidence: different });
  expect(arbitrary.isError).toBe(true);
  const integrationTaskId = f.store.listWork(f.project.id).find(w => w.sec === "next")!.taskId!;
  f.orch.saveTask(f.lead, { taskId: integrationTaskId, contract });
  const report = await f.orch.recordPost(f.worker, { taskId: integrationTaskId, kind: "완료", title: "원격 main 통합 확인",
    body: `검수 커밋 ${commit}이 원격 main ${different}에 포함됩니다.`, contractRev: 1,
    checks: [{ name: "통합 결과", kind: "other", result: "pass", criterion: 1, evidence: "포함을 확인했습니다" }],
  });
  const merged = await f.tool(f.lead, "task_stage", { task_id: f.source.id, stage: "merged",
    evidence: different + " 원격 main 포함 확인", integration_report: report.id, main_commit: different });
  expect(merged.isError, merged.text).toBeUndefined();
  const cleanup = f.store.listWork(f.project.id).find(w => w.title.includes("작업 브랜치 정리"));
  expect(cleanup?.detail).toContain(different);
  const issue = await f.orch.recordPost(f.worker, { taskId: cleanup!.taskId!, kind: "막힘", title: "작업 브랜치를 다른 워크트리에서 사용 중", body: "원격 main 포함은 확인했고 브랜치 정리만 보류했습니다." });
  const result = await f.tool(f.lead, "task_followup", { task_id: f.source.id, kind: "repair", report_id: issue.id, title: "사용 중인 워크트리 확인 후 브랜치 정리" });
  expect(result.isError, result.text).toBeUndefined();
  expect(f.store.taskProgress(f.source.id).finalReview?.status).toBe("confirmed");
  expect(f.store.taskProgress(cleanup!.taskId!).stage).toBe("hold");
  expect(f.store.listWork(f.project.id).some(w => w.sec === "next" && w.title === "사용 중인 워크트리 확인 후 브랜치 정리")).toBe(true);
});


test("the actual worker pump leaves a stale integration request in the queue", async () => {
  const f = await readyForReview();
  expect((await f.confirm()).isError).toBeUndefined();
  const integrationTaskId = f.store.listWork(f.project.id).find(w => w.sec === "next")?.taskId;
  expect(integrationTaskId).toBeTruthy();
  f.runner.busy.add(f.worker.id);
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: integrationTaskId, text: "검수한 커밋을 통합합니다", contract }, f.lead);
  const input = f.store.listPending(f.worker.id).find(d => d.taskId === integrationTaskId);
  expect(input?.status).toBe("queued");
  f.orch.saveTask(f.lead, { taskId: f.source.id, contract: { ...contract, acceptance: ["변경의 새 조건을 검사합니다"] } });
  f.runner.busy.delete(f.worker.id);
  await f.orch.pump(f.worker.id);
  expect(f.store.requireDelivery(input!.id).status).toBe("queued");
  expect(f.store.taskProgress(integrationTaskId!).stage).toBe("hold");
  expect(f.runner.to(f.worker)).toHaveLength(0);
  const independent = f.orch.saveTask(f.lead, { title: "다른 화면 확인", contract }).task;
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: independent.id, text: "별도 화면의 기준을 확인합니다", contract }, f.lead);
  expect(f.runner.to(f.worker)).toHaveLength(1);
  expect(f.store.requireDelivery(input!.id).status).toBe("queued");
});

test("changing the work branch cannot reuse the previous exact-commit review", async () => {
  const f = await readyForReview();
  expect((await f.confirm()).isError).toBeUndefined();
  f.orch.saveTask(f.lead, { taskId: f.source.id, branch: "fix/another-branch" });
  expect((await f.integration()).isError).toBe(true);
  expect(f.store.listWork(f.project.id).filter(w => w.sec === "next")).toHaveLength(1);
});

test("an unstructured review note cannot authorize branch cleanup", async () => {
  const f = await readyForReview();
  const result = await f.tool(f.lead, "task_stage", { task_id: f.source.id, stage: "done", evidence: "검수한 작업 브랜치 커밋 " + commit });
  expect(result.isError).toBeUndefined();
  expect((await f.integration()).isError).toBe(true);
  expect(f.store.listWork(f.project.id)).toHaveLength(0);
});


test("the conductor cannot approve a different commit than the tested worker artifact", async () => {
  const f = await readyForReview();
  const wrong = await f.tool(f.lead, "task_stage", { task_id: f.source.id, stage: "done", evidence: "다른 커밋", reviewed_commit: different });
  expect(wrong.isError).toBe(true);
  expect(f.store.taskProgress(f.source.id).finalReview?.status).toBe("pending");
  expect((await f.confirm()).isError).toBeUndefined();
});


test("a previously ordinary confirmation can attach the exact structured worker artifact", async () => {
  const f = await readyForReview();
  const general = await f.tool(f.lead, "task_stage", { task_id: f.source.id, stage: "done", evidence: "통과 결과를 확인했습니다" });
  expect(general.isError).toBeUndefined();
  expect((await f.integration()).isError).toBe(true);
  expect((await f.confirm()).isError).toBeUndefined();
  expect(f.store.listWork(f.project.id).filter(w => w.sec === "next")).toHaveLength(1);
});


test("a new owner instruction suspends stale integration without blocking other worker work", async () => {
  const f = await readyForReview();
  expect((await f.confirm()).isError).toBeUndefined();
  const integrationId = f.store.listWork(f.project.id).find(w => w.sec === "next")!.taskId!;
  f.runner.busy.add(f.worker.id);
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: integrationId, text: "검수한 커밋을 통합합니다", contract }, f.lead);
  const other = f.orch.saveTask(f.lead, { title: "다른 승인 작업", contract }).task;
  await f.orch.assign(f.project.id, f.worker.handle, { taskId: other.id, text: "다른 작업의 검사를 실행합니다", contract }, f.lead);
  f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: f.source.id,
    kind: "user_message", text: "새 조건을 확인한 뒤 다시 검수해 주세요" });
  f.runner.busy.delete(f.worker.id);
  await f.orch.pump(f.worker.id);
  expect(f.store.taskProgress(integrationId).stage).toBe("hold");
  expect(f.runner.to(f.worker)).toHaveLength(1);
  expect(f.runner.to(f.worker)[0]).toContain("다른 작업의 검사를 실행합니다");
});
