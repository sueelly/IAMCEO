import type { ContractInput } from "../server/harness.ts";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as policy from "../server/task-main-followup.ts";
import { fixture, writeExec } from "./fixtures/harness-fixture.ts";
import { latestCompletionReview } from "../server/task-completion.ts";

const origin = "https://github.com/example/authoring.git";
const source = "대표의 집필 서비스 코드 main 통합·일반 푸시 승인, 11월 18일";
const contract = { kind: "coding" as const, goal: "설정 저장 구현", scope: "설정 저장", inputs: ["설정"],
  outputs: ["설정 저장 결과"], constraints: [], exclusions: ["배포"], acceptance: ["설정 저장이 유지된다"], checks: ["behavior" as const] };

function setup() {
  const f = fixture();
  const git = (cwd: string, ...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const root = f.project.cwd, tree = join(f.isolated.dir, "linked"), branch = "implement-setting";
  git(root, "init", "-b", "main"); git(root, "remote", "add", "origin", origin);
  git(root, "commit", "--allow-empty", "-m", "base");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "worktree", "add", "-b", branch, tree);
  const commit = (path: string) => {
    mkdirSync(join(tree, path, ".."), { recursive: true });
    writeFileSync(join(tree, path), "saved");
    git(tree, "add", "--", path); git(tree, "commit", "-m", "save setting");
    return git(tree, "rev-parse", "HEAD");
  };
  f.runner.busy.add(f.lead.id);
  const { task } = f.orch.saveTask(f.lead, { title: "서비스 설정 저장", branch, worktree: tree, contract });
  const register = (contracts: { taskId: string; rev: number }[] = []) => {
    expect(typeof policy.registerProjectMainPolicy).toBe("function");
    return policy.registerProjectMainPolicy(f.store, f.project.id, { origin, paths: ["app"], source, contracts });
  };
  const report = async (sha: string) => {
    writeExec(f.isolated.paths.claudeHome, f.worker, "bun test setting", 0);
    const result = await f.tool(f.worker, "post", { task_id: task.id, kind: "완료", title: "설정 저장 확인", artifact_commit: sha, contract_rev: 1,
      checks: [{ name: "설정 유지", kind: "behavior", command: "bun test setting", result: "pass", criterion: 1, evidence: "저장 뒤 확인" }] });
    expect(result.isError, result.text).toBeUndefined();
    return latestCompletionReview(f.store, task.id)!;
  };
  return { ...f, task, git, tree, branch, commit, report, register };
}

test("a registered project scope recognizes an existing verified delta without revising its execution evidence", async () => {
  const f = setup();
  const head = f.commit("app/settings.ts");
  const prior = await f.report(head);
  const history = f.store.listTaskContracts(f.task.id), evidence = f.store.getReportHarness(prior.report_id);
  expect(f.store.listWork(f.project.id)).toHaveLength(0);
  f.register();
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toContain(source);
  expect(f.store.listTaskContracts(f.task.id)).toEqual(history);
  expect(f.store.getReportHarness(prior.report_id)).toEqual(evidence);
  expect(latestCompletionReview(f.store, f.task.id)?.report_id).toBe(prior.report_id);
  const integrations = () => f.store.listWork(f.project.id).filter(work => work.title.includes("main 통합"));
  expect(integrations()).toHaveLength(1);
  f.register();
  expect(integrations()).toHaveLength(1);
});

test("future contracts and prose-only reports receive scope from their real product paths", async () => {
  const f = setup();
  f.register();
  const later = f.orch.saveTask(f.lead, { title: "저장 화면", parentTaskId: f.task.id, contract: { ...contract, outputs: ["app/ui.tsx"] } }).task;
  f.orch.saveTask(f.lead, { taskId: later.id, worktree: f.tree, branch: f.branch });
  expect(f.store.getEffectiveContract(later.id)?.main_authority).toContain(source);
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toBeUndefined();
  await f.report(f.commit("app/settings.ts"));
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toContain(source);
  expect(f.store.listWork(f.project.id).filter(w => w.title.includes("main 통합"))).toHaveLength(1);
});

test("an exact contract enrollment stays on its own revision, project, and linked checkout with the registered origin", () => {
  const f = setup();
  f.register([{ taskId: f.task.id, rev: 1 }]);
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toContain(source);
  const child = f.orch.saveTask(f.lead, { title: "다른 업무", parentTaskId: f.task.id }).task;
  expect(f.store.getEffectiveContract(child.id)?.main_authority).toBeUndefined();
  const nested = join(f.tree, "app");
  mkdirSync(nested);
  f.git(nested, "init", "-b", f.branch); f.git(nested, "remote", "add", "origin", origin);
  f.orch.saveTask(f.lead, { taskId: f.task.id, worktree: nested });
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toBeUndefined();
  f.orch.saveTask(f.lead, { taskId: f.task.id, worktree: f.tree });
  f.git(f.tree, "remote", "set-url", "--push", "origin", "https://github.com/other/authoring.git");
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toBeUndefined();
  f.git(f.tree, "remote", "set-url", "--push", "origin", origin);
  f.orch.saveTask(f.lead, { taskId: f.task.id, contract: { ...contract, scope: "통합 인계 조사" } });
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toBeUndefined();
});

test("a main exclusion, review-only task, or mixed repository delta cannot acquire project integration", async () => {
  const f = setup(); f.register();
  for (const override of [{ exclusions: ["main·운영·실데이터 변경"] }, { constraints: ["작업 브랜치만 일반 푸시한다"] }, { kind: "research" as const }, { scope: "읽기 전용 검수" }]) {
    const { contract: saved } = f.orch.saveTask(f.lead, { taskId: f.task.id, contract: { ...contract, outputs: ["app/ui.tsx"], ...override } });
    expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toBeUndefined();
    expect(() => f.register([{ taskId: f.task.id, rev: saved!.rev }])).toThrow();
  }
  const g = setup(); g.register();
  g.commit("app/settings.ts");
  await g.report(g.commit("private/source.txt"));
  expect(g.store.getEffectiveContract(g.task.id)?.main_authority).toBeUndefined();
  expect(g.store.listWork(g.project.id)).toHaveLength(0);
});

test.each([true, false])("integration eligibility uses the selected report's exact delta (selected product = %s)", async product => {
  const f = setup();
  const first = f.commit(product ? "app/setting" : "private/setting");
  const selected = await f.report(first);
  const evidence = f.store.getReportHarness(selected.report_id)!;
  f.git(f.tree, "checkout", "-B", f.branch, evidence.artifactBase!);
  const second = f.commit(product ? "private/setting" : "app/setting");
  const other = f.store.createMessage({ projectId: f.project.id, taskId: f.task.id, memberId: f.worker.id, who: f.worker.name, kind: "완료", title: "다른 제출판" });
  f.store.recordReportChecks(other, f.worker, f.store.latestTaskChecks(f.task.id), { gate: "contract", contractTaskId: f.task.id, contractRev: 1,
    artifact: { branch: f.branch, commit: second, base: evidence.artifactBase! } });
  f.register();
  expect(policy.currentIntegrationCommit(f.store, f.task, selected.report_id)).toBe(product ? first : null);
  expect(f.store.listWork(f.project.id).filter(w => w.title.includes("main 통합"))).toHaveLength(product ? 1 : 0);
});

test("revoking this policy stops its pending integration and re-registration cannot inherit old task enrollments", () => {
  const f = setup();
  const active = f.register([{ taskId: f.task.id, rev: 1 }]);
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toContain(source);
  expect(typeof policy.revokeProjectMainPolicy).toBe("function");
  policy.revokeProjectMainPolicy(f.store, f.project.id, active.policyId);
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toBeUndefined();
  const next = f.register();
  expect(next.policyId).not.toBe(active.policyId);
  policy.revokeProjectMainPolicy(f.store, f.project.id, active.policyId);
  expect(f.register().policyId).toBe(next.policyId);
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toBeUndefined();
});

test("a normal-push approval respects force-push restrictions and skips original text extraction", () => {
  const f = setup(); f.register();
  const save = (patch: Partial<ContractInput>) => f.orch.saveTask(f.lead, { taskId: f.task.id, contract: { ...contract, outputs: ["app/result.ts"], ...patch } }).contract;
  expect(save({ exclusions: ["force push", "강제 푸시", "운영 배포"] })?.main_authority).toContain(source);
  expect(save({ goal: "전독시 실제 원문 추출" })?.main_authority).toBeUndefined();
  expect(save({ constraints: ["작업 브랜치 일반 푸시까지만"] })?.main_authority).toBeUndefined();
});

test("only a force-push restriction leaves ordinary project integration available", () => {
  const f = setup(); f.register();
  const check = (patch: Partial<ContractInput>) =>
    f.orch.saveTask(f.lead, { taskId: f.task.id, contract: { ...contract, outputs: ["app/result.ts"], ...patch } }).contract?.main_authority;
  for (const restrictions of [
    { constraints: ["main 강제 푸시 금지", "no force push to main"] },
    { exclusions: ["운영 배포·main 강제 푸시", "git push --force-with-lease origin main"] },
    { forbidden: ["no force-push to main", "origin/main에 강제 푸시"] },
  ]) expect(check(restrictions)).toContain(source);

  for (const restrictions of [
    { exclusions: ["공유 main·운영·강제 푸시"] }, { constraints: ["main 병합과 강제 푸시 금지"] },
    { constraints: ["main 강제 푸시 금지. 작업 브랜치만 일반 푸시한다"] },
    { exclusions: ["main 강제 푸시 및 일반 푸시"] }, { constraints: ["no merge or force push to main"] },
  ]) expect(check(restrictions)).toBeUndefined();
});

test("scoped integration cannot publish out-of-scope files retained in intermediate commit history", async () => {
  const f = setup(); f.register();
  f.commit("private/source.txt");
  f.git(f.tree, "rm", "private/source.txt");
  const head = f.commit("app/setting");
  await f.report(head);
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toBeUndefined();
  expect(f.store.listWork(f.project.id)).toHaveLength(0);
});

test("copying an effective main policy into a later restricted revision does not convert it into a direct grant", () => {
  const f = setup();
  f.register([{ taskId: f.task.id, rev: 1 }]);
  const prior = f.store.getEffectiveContract(f.task.id)!;
  f.orch.saveTask(f.lead, { taskId: f.task.id, contract: { ...contract, main_authority: prior.main_authority, exclusions: ["공용 main"] } });
  expect(f.store.getEffectiveContract(f.task.id)?.main_authority).toBeUndefined();
});

test("a prepared worker envelope cannot be replayed with a revoked project integration scope", async () => {
  const f = setup();
  const active = f.register([{ taskId: f.task.id, rev: 1 }]);
  f.runner.send = async () => ({ ok: false, reason: "error", retryable: false, deliveryEffect: "unknown" });
  const assignment = await f.orch.assign(f.project.id, f.worker.handle, { taskId: f.task.id, text: "설정 저장 작업" }, f.lead);
  const dispatch = f.store.listDeliveryDispatches(assignment.delivery.id).at(-1)!;
  expect(dispatch.wireText).toContain(source);
  expect(f.orch.deliveryRecovery.executionContextValid(dispatch)).toBe(true);
  policy.revokeProjectMainPolicy(f.store, f.project.id, active.policyId);
  expect(f.orch.deliveryRecovery.executionContextValid(dispatch)).toBe(false);
});
