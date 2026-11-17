import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listAgentTools } from "../server/agent-tools.ts";
import { checkCompletionReviews, completionReviewAllowsDelivery } from "../server/task-completion.ts";
import { activeTaskContinuationPauses } from "../server/task-continuation.ts";
import { fixture, until } from "./fixtures/harness-fixture.ts";

const contract = { kind: "other" as const, goal: "변경 검증", scope: "등록한 작업 브랜치",
  inputs: ["대표 요청"], outputs: ["검증한 작업 브랜치"], constraints: [], exclusions: [],
  acceptance: ["요청한 조건을 검사한다"], checks: [] };

async function pendingReview() {
  const f = fixture(), reviewer = f.store.ensureFinalReviewer(f.project.id)!;
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=Reviewer Test", "-c", "user.email=review@example.invalid", ...args],
    { cwd: f.project.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  writeFileSync(join(f.project.cwd, "setting.txt"), "before\n");
  git("add", "setting.txt");
  git("commit", "-m", "Initial setting");
  git("checkout", "-b", "fix/setting");
  writeFileSync(join(f.project.cwd, "setting.txt"), "after\n");
  git("add", "setting.txt");
  git("commit", "-m", "Restore setting");
  const head = git("rev-parse", "HEAD");
  const source = f.orch.saveTask(f.lead, { title: "색상 설정 복구", branch: "fix/setting", contract }).task;
  const report = await f.orch.recordPost(f.worker, { taskId: source.id, kind: "완료", title: "설정 복구 검증", contractRev: 1, artifactCommit: head,
    checks: [{ name: "설정 유지 확인", kind: "other", result: "pass", evidence: "상태를 확인했습니다", criterion: 1 }] });
  expect(f.store.taskProgress(source.id).finalReview?.status).toBe("pending");
  return { ...f, reviewer, source, report, head };
}

test("one dedicated reviewer is reused and review is routed there while the conductor is busy", async () => {
  const f = await pendingReview();
  expect(f.reviewer.finalReviewer).toBe(true);
  expect(f.store.ensureFinalReviewer(f.project.id)?.id).toBe(f.reviewer.id);
  f.store.patchMember(f.lead.id, { status: "working" });
  const [delivery] = checkCompletionReviews(f.store, Date.now() + 60_000, 30_000);
  expect(delivery).toMatchObject({ memberId: f.reviewer.id, taskId: f.source.id, wake: true, refId: null });
  expect(delivery?.text).toContain(f.report.id);
  expect(checkCompletionReviews(f.store, Date.now() + 120_000, 30_000)).toHaveLength(0);
});

test("starting an inactive project provisions its managed reviewer without starting a review", async () => {
  const f = fixture();
  f.store.patchProject(f.project.id, { runnerEnabled: false });
  expect(f.store.ensureFinalReviewer(f.project.id)).toBeNull();
  expect(f.store.ensureFinalReviewer("hq")).toBeNull();
  await f.orch.startConductor(f.project.id);
  const reviewer = f.store.getFinalReviewer(f.project.id)!;
  expect(reviewer).toMatchObject({ finalReviewer: true, status: "offline" });
  expect(f.runner.to(reviewer)).toHaveLength(0);
  await expect(f.orch.closeMember(reviewer.id)).rejects.toThrow("명부에서 제거할 수 없습니다");
  expect(f.store.getFinalReviewer(f.project.id)?.id).toBe(reviewer.id);
});

test("the scheduler wakes the offline reviewer in read-only mode and keeps the original report receipt", async () => {
  const f = await pendingReview();
  const originalDelivery = f.store.requireMessage(f.report.id).delivery;
  f.runner.busy.add(f.lead.id);
  expect(f.reviewer.status).toBe("offline");
  const [delivery] = f.orch.checkTaskContinuations(Date.now() + 60_000).filter(d => d.memberId === f.reviewer.id);
  expect(delivery).toBeDefined();
  await until("검수 직원의 실제 입력", () => f.store.requireDelivery(delivery!.id).status === "delivered");
  expect(f.runner.to(f.reviewer).some(text => text.includes(f.report.id))).toBe(true);
  const reviewer = f.store.requireMember(f.reviewer.id);
  expect(f.orch["runnerMember"](reviewer, f.store.requireProject(f.project.id)).kind).toBe("conductor");
  expect(f.store.requireDelivery(delivery!.id).status).toBe("delivered");
  expect(f.store.requireMessage(f.report.id).delivery).toBe(originalDelivery);
  expect(f.store.taskProgress(f.source.id).finalReview?.status).toBe("pending");
  const before = f.store.listDeliveries(f.project.id).filter(d => d.memberId === f.lead.id).length;
  f.runner.busy.delete(reviewer.id);
  await f.orch["onTurnEnd"](reviewer, { type: "turn_end", memberId: reviewer.id, finalText: "별도 보고 대신 검수 기록을 사용합니다", isError: false });
  expect(f.store.listDeliveries(f.project.id).filter(d => d.memberId === f.lead.id)).toHaveLength(before);
});

test("the dedicated reviewer confirms the exact report and queues integration once", async () => {
  const f = await pendingReview();
  const tools = listAgentTools(f.reviewer).map(t => t.name);
  expect(tools).toContain("task_review");
  expect(tools).not.toContain("team_assign");
  expect(tools).not.toContain("file");
  const args = { task_id: f.source.id, report_id: f.report.id, result: "confirmed", evidence: "계약과 검사, 작업 브랜치 SHA를 대조했습니다", reviewed_commit: f.head };
  expect((await f.tool(f.worker, "task_review", args)).isError).toBe(true);
  expect((await f.tool(f.lead, "task_stage", { task_id: f.source.id, stage: "done", evidence: "빠른 확인", reviewed_commit: f.head })).isError).toBe(true);
  expect((await f.tool(f.reviewer, "task_review", { ...args, report_id: "stale" })).isError).toBe(true);
  expect((await f.tool(f.reviewer, "task_review", args)).isError).toBe(true);
  const evidence = await f.tool(f.reviewer, "task_review_evidence", { task_id: f.source.id, report_id: f.report.id, path: "setting.txt" });
  expect(evidence.isError, evidence.text).toBeUndefined();
  expect(JSON.parse(evidence.text)).toMatchObject({ contract: { acceptance: contract.acceptance },
    patch: { state: "observed", commit: f.head, patch: expect.stringContaining("+after") } });
  const result = await f.tool(f.reviewer, "task_review", args);
  expect(result.isError, result.text).toBeUndefined();
  expect((await f.tool(f.reviewer, "task_review", args)).isError).toBeUndefined();
  expect((await f.tool(f.reviewer, "task_review", { ...args, reviewed_commit: "e".repeat(40) })).isError).toBe(true);
  expect(f.store.taskProgress(f.source.id).finalReview?.status).toBe("confirmed");
  expect(f.store.listWork(f.project.id).filter(w => w.sec === "next")).toHaveLength(1);
});

test("owner stop retains the review and blocks further verdicts and delivery", async () => {
  const f = await pendingReview();
  const [reminder] = f.orch.checkTaskContinuations(Date.now() + 60_000).filter(d => d.memberId === f.reviewer.id);
  await until("검수 실행", () => f.store.requireDelivery(reminder!.id).status === "delivered");
  const stopped = await f.orch.stopMember(f.reviewer.id, { by: "user" });
  expect(stopped.outcome).toBe("stopped");
  expect(f.orch.checkTaskContinuations(Date.now() + 120_000).filter(d => d.memberId === f.reviewer.id)).toHaveLength(0);
  expect(activeTaskContinuationPauses(f.store, f.project.id).map(p => p.taskId)).toContain(f.source.id);
  expect(f.store.taskProgress(f.source.id).finalReview?.status).toBe("pending");
  expect((await f.tool(f.reviewer, "task_review", { task_id: f.source.id, report_id: f.report.id,
    result: "changes_requested", evidence: "중단 전 발견", repair_title: "수정" })).isError).toBe(true);
});

test("a review finding creates one scoped repair and a conductor notification", async () => {
  const f = await pendingReview();
  const args = { task_id: f.source.id, report_id: f.report.id, result: "changes_requested",
    evidence: "재시작 후 설정이 초기화되는 재현을 확인했습니다", repair_title: "재시작 뒤 설정 초기화 수정" };
  expect((await f.tool(f.reviewer, "task_review", args)).isError).toBeUndefined();
  expect((await f.tool(f.reviewer, "task_review", args)).isError).toBeUndefined();
  expect(f.store.taskProgress(f.source.id).finalReview?.status).toBe("changes_requested");
  expect(f.store.listWork(f.project.id).filter(w => w.title === args.repair_title)).toHaveLength(1);
  expect(f.store.listDeliveries(f.project.id).filter(d => d.memberId === f.lead.id && d.text.includes(args.repair_title))).toHaveLength(1);
});

test("an old unsent conductor reminder is retired without reusing its receipt", async () => {
  const f = await pendingReview();
  const old = f.store.enqueue({ projectId: f.project.id, memberId: f.lead.id, taskId: f.source.id,
    kind: "system", text: "[시스템] 비동기 최종 확인: 이전 요청", wake: true });
  f.store.db.query("UPDATE task_completion_reviews SET delivery_id=? WHERE task_id=?").run(old.id, f.source.id);
  const [delivery] = checkCompletionReviews(f.store, Date.now() + 60_000, 30_000);
  expect(delivery?.memberId).toBe(f.reviewer.id);
  expect(f.store.requireDelivery(old.id).status).toBe("failed");
  expect(completionReviewAllowsDelivery(f.store, old)).toBe(false);
});
