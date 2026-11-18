import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, until, writeExec } from "./fixtures/harness-fixture.ts";
import { checkCompletionReviews, latestCompletionReview, synchronizeTaskCompletion } from "../server/task-completion.ts";

const contract = { kind: "coding" as const, goal: "설정 유지", scope: "설정 저장", inputs: ["설정 파일"], outputs: ["저장 결과"],
  constraints: [], exclusions: ["배포"], acceptance: ["재시작 후 설정이 유지된다"], checks: ["behavior"] };
const check = { name: "설정 유지", kind: "behavior", command: "python3 verify.py", result: "pass", criterion: 1, evidence: "재시작 뒤 값을 대조했습니다" };
const remoteCommand = "git ls-remote origin refs/heads/main";
const beforeCommand = "git ls-remote --exit-code origin refs/heads/main";

async function sourceWithGit(authorized = true) {
  const f = fixture(), reviewer = f.store.ensureFinalReviewer(f.project.id)!;
  f.runner.busy.add(f.lead.id);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=Integration", "-c", "user.email=test@example.invalid", ...args],
    { cwd: f.project.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  git("init", "-b", "main");
  git("init", "--bare", "--initial-branch=main", "../origin.git");
  git("remote", "add", "origin", "../origin.git");
  writeFileSync(join(f.project.cwd,"setting"), "initial");
  git("add", "."); git("commit", "-m", "initial"); git("push", "origin", "main");
  const base = git("rev-parse", "main");
  git("checkout", "-b", "save-settings");
  // The feature and its restart check land in separate commits. The first commit
  // contains a real empty-value bug outside the worker's initial example.
  writeFileSync(join(f.project.cwd, "settings.py"), [
    "import sys", "from pathlib import Path", "mode, filename, *args = sys.argv[1:]", "state = Path(filename)",
    "if mode == 'save' and args[0]:", "    state.write_text(args[0])",
    "elif mode == 'load':", "    print(state.read_text() if state.exists() else 'default')",
  ].join("\n"));
  git("add", "settings.py"); git("commit", "-m", "save settings");
  writeFileSync(join(f.project.cwd, "verify.py"), [
    "import subprocess, sys, tempfile", "from pathlib import Path", "value = sys.argv[1] if len(sys.argv) > 1 else 'dark'",
    "with tempfile.TemporaryDirectory() as directory:", "    filename = str(Path(directory) / 'settings')",
    "    subprocess.run([sys.executable, 'settings.py', 'save', filename, value], check=True)",
    "    actual = subprocess.check_output([sys.executable, 'settings.py', 'load', filename], text=True).rstrip('\\n')",
    "    assert actual == value, (actual, value)", "print('setting restored')",
  ].join("\n"));
  git("add", "verify.py"); git("commit", "-m", "verify settings after restart");
  const runBehavior = () => {
    const output = execFileSync("/usr/bin/python3", ["verify.py"], { cwd: f.project.cwd, encoding: "utf8" });
    writeExec(f.isolated.paths.claudeHome, f.worker, check.command, 0, output);
  };
  const head = git("rev-parse", "HEAD");
  git("push", "origin", "save-settings");
  const saved = await f.tool(f.lead, "task", { title: "설정 저장", branch: "save-settings",
    contract: { ...contract, ...(authorized ? { main_authority: "대표의 이 저장소 main 일반 푸시 지속 승인" } : {}) } });
  expect(saved.isError, saved.text).toBeUndefined();
  const task = f.store.listTasks(f.project.id).find(t => t.branch === "save-settings")!;
  runBehavior();
  const post = await f.tool(f.worker, "post", { kind: "완료", title: "설정 검증", task_id: task.id,
    artifact_commit: head, contract_rev: 1, checks: [check] });
  expect(post.isError, post.text).toBeUndefined();
  return { ...f, reviewer, git, task, base, head, runBehavior, reportId: latestCompletionReview(f.store, task.id)!.report_id };
}

test("a worker receives one scoped integration, updates a real isolated remote, and receives the post-merge defect without coordinator or review gating", async () => {
  const f = await sourceWithGit();
  const integration = f.store.listWork(f.project.id).find(w => w.title.includes("main 통합"));
  expect(integration).toBeDefined();
  const taskId = integration!.taskId!;
  const deliveries = () => f.store.listTaskDeliveries(taskId).filter(d => d.kind === "instruction");
  synchronizeTaskCompletion(f.store, f.task.id);
  expect(deliveries()).toHaveLength(1);
  expect(deliveries()[0]?.memberId).toBe(f.worker.id);
  await until("통합 담당자 수신", () => deliveries()[0]?.status === "delivered");
  expect(f.runner.to(f.lead)).toHaveLength(0);
  expect(f.runner.to(f.reviewer)).toHaveLength(0);
  expect(f.store.getReportHarness(f.reportId)?.artifactBase).toBe(f.base);
  expect(f.store.getEffectiveContract(taskId)?.exclusions).toContain("배포");
  const report = (main: string, includeBefore = true) => f.tool(f.worker, "post", { kind: "완료", title: "통합 검증", task_id: taskId, main_commit: main,
    main_base: f.base, contract_rev: 1, body: `작업 ${f.head} · 원격 main ${main}`,
    checks: [check, ...(includeBefore ? [{ ...check, name:"통합 전 main", kind:"behavior", command:beforeCommand }] : []), { ...check, name:"원격 main", criterion: 2, kind: "behavior", command: remoteCommand, evidence: main }] });
  const witness = () => writeExec(f.isolated.paths.claudeHome, f.worker, remoteCommand, 0, f.git("ls-remote", "origin", "refs/heads/main"));
  const beforeOutput = f.git("ls-remote", "--exit-code", "origin", "refs/heads/main");
  writeExec(f.isolated.paths.claudeHome, f.worker, beforeCommand, 0, beforeOutput);
  witness();
  expect((await report(f.head)).isError).toBe(true);
  f.git("checkout", "main"); f.git("merge", "--no-ff", "save-settings", "-m", "integrate settings");
  f.git("push", "origin", "main");
  const main = f.git("rev-parse", "HEAD");
  expect(f.git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0]).toBe(main);
  f.runBehavior();
  witness();
  expect((await report(main, false)).isError).toBe(true);
  const posted = await report(main);
  expect(posted.isError, posted.text).toBeUndefined();
  expect((await report(main)).isError).toBeUndefined();
  expect(f.store.listStageMarks(f.task.id).filter(m => m.stage === "merged")).toHaveLength(1);
  expect(latestCompletionReview(f.store, f.task.id)).toMatchObject({ status: "pending", main_base: f.base, main_commit: main });
  const due = checkCompletionReviews(f.store, Date.now() + 60_000, 30_000);
  expect(due.some(d => d.memberId === f.reviewer.id && d.text.includes(f.reportId))).toBe(true);
  expect((await f.tool(f.reviewer, "task_review_evidence", { task_id:f.task.id, report_id:f.reportId, path:"verify.py" })).isError).toBeUndefined();
  const defect = spawnSync("/usr/bin/python3", ["verify.py", ""], { cwd: f.project.cwd, encoding: "utf8" });
  expect(defect.status).toBe(1);
  expect(defect.stderr).toContain("('default', '')");
  const issue = { task_id: f.task.id, report_id: f.reportId, result: "changes_requested", repair_title: "빈 설정 저장 복구", evidence: "빈 설정을 저장한 뒤 다시 열면 값이 사라집니다" };
  const repair = await f.tool(f.reviewer, "task_review", issue);
  expect(repair.isError, repair.text).toBeUndefined();
  expect((await f.tool(f.reviewer, "task_review", issue)).isError).toBeUndefined();
  expect(f.store.taskProgress(f.task.id).stage).toBe("done");
  expect(f.store.listStageMarks(f.task.id).filter(m => m.stage === "merged")).toHaveLength(1);
  const fixes = f.store.listWork(f.project.id).filter(w => w.title === issue.repair_title);
  expect(fixes).toHaveLength(1);
  expect(f.store.listTaskDeliveries(fixes[0]!.taskId!).filter(d => d.kind === "instruction").map(d => d.memberId)).toEqual([f.worker.id]);
});

test("a branch-only contract leaves the remote alone and its artifact review can run immediately", async () => {
  const f = await sourceWithGit(false);
  expect(f.store.listWork(f.project.id)).toHaveLength(0);
  expect(f.git("ls-remote", "origin", "refs/heads/main").split(/\s/)[0]).toBe(f.base);
  expect(checkCompletionReviews(f.store, Date.now() + 100, 10).some(d => d.text.includes(f.reportId))).toBe(true);
});

test("reconciliation recovers only an obsolete server integration hold and preserves an operator hold", async () => {
  const f = await sourceWithGit();
  const work = f.store.listWork(f.project.id).find(w => w.title.includes("main 통합"))!;
  const taskId = work.taskId!;
  f.store.addStageMark({ projectId: f.project.id, taskId, stage: "hold", memberId: null, who: "하네스",
    evidence: `원 업무 #${f.task.id}의 계약 또는 검수 기록이 바뀌어 후속 지시를 보류합니다` });
  f.store.upsertWork({ ...work, sec: "hold" });
  synchronizeTaskCompletion(f.store, f.task.id);
  expect(f.store.listStageMarks(taskId).at(-1)?.stage).toBe("reopen");
  expect(f.store.listTaskDeliveries(taskId).filter(d => d.kind === "instruction")).toHaveLength(1);
  f.store.addStageMark({ projectId: f.project.id, taskId, stage: "hold", memberId: f.lead.id, who: f.lead.name, evidence: "대표 승인 확인" });
  synchronizeTaskCompletion(f.store, f.task.id);
  expect(f.store.listStageMarks(taskId).at(-1)?.stage).toBe("hold");
});

test("a reporter cannot upgrade a branch-only task through a later independent verdict", async () => {
  const f = await sourceWithGit(false);
  const read = await f.tool(f.reviewer, "task_review_evidence", { task_id:f.task.id, report_id:f.reportId, path:"settings.py" });
  expect(read.isError, read.text).toBeUndefined();
  const review = await f.tool(f.reviewer, "task_review", { task_id: f.task.id, report_id: f.reportId, result: "confirmed", evidence: "최종 확인", reviewed_commit: f.head });
  expect(review.isError, review.text).toBeUndefined();
  expect(f.store.listWork(f.project.id)).toHaveLength(0);
  expect((await f.tool(f.lead, "task_followup", { task_id:f.task.id, kind:"integration", reviewed_commit:f.head })).isError).toBe(true);
});
