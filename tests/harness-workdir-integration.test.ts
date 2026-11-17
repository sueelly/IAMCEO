// 격리된 가짜 세션·DB만 쓰는 API 회귀. 실제 QA 제출이나 진단은 호출하지 않는다.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

const command = "bun  test 'synthetic test.ts'";
const id = (r: { text: string }, prefix = "tk") => r.text.match(new RegExp(`#(${prefix}_[\\w-]+)`))![1]!;
async function setup() {
  const f = fixture(), member = f.make("workdir", "합성 Codex", "worker", "codex");
  const task = id(await f.tool(f.lead, "task", { title: "합성 위치 대조", contract: { kind: "coding", goal: "정확한 위치", acceptance: ["실행 위치가 맞다"], checks: ["behavior"] } }));
  const workdir = join(member.cwd, "검수 결과");
  const put = (cwd: string) => {
    const at = new Date().toISOString(), path = join(f.isolated.paths.codexHome, "sessions", "synthetic", "rollout-workdir.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      { type: "session_meta", timestamp: at, payload: { id: member.sessionId, cwd: member.cwd } },
      { type: "event_msg", timestamp: at, payload: { type: "item_completed", thread_id: member.sessionId, item: { type: "CommandExecution", id: "synthetic-exec", command: ["/bin/zsh", "-lc", command], cwd: pathToFileURL(cwd).href, status: "completed", exit_code: 0 } } },
    ].map(r => JSON.stringify(r)).join("\n") + "\n");
  };
  const post = (result: "pass" | "fail", extra: Record<string, unknown> = {}) => f.tool(member, "post", {
    task_id: task, kind: result === "pass" ? "완료" : "막힘", title: "합성 위치 검사", contract_rev: 1,
    checks: [{ name: "합성 검사", kind: "behavior", result, command, evidence: "합성 기록 대조", criterion: 1, ...extra }],
  });
  return { ...f, member, task, workdir, put, post };
}

test("API→기록→완료 판정은 원 command와 명시 workdir를 각각 보존한다", async () => {
  const s = await setup(); s.put(s.workdir);
  const response = await s.post("pass", { workdir: s.workdir });
  expect(response.isError).toBeUndefined();
  const report = id(response, "msg"), stored = s.store.getReportHarness(report)!;
  expect(stored.checks[0]).toMatchObject({ command, workdir: s.workdir, execCommand: command, execStatus: "matched", execExit: 0 });
  expect(s.store.latestTaskChecks(s.task)[0]).toMatchObject({ command, workdir: s.workdir });
  const read = await s.tool(s.member, "post", { report_id: report });
  expect(read.isError).toBeUndefined();
  expect(JSON.parse(read.text).harness.checks[0]).toMatchObject({ command, workdir: s.workdir });
});

test("기존 workdir 생략 보고는 등록 위치의 file URI만 받아들인다", async () => {
  const same = await setup(); same.put(same.member.cwd);
  const result = await same.post("pass"); expect(result.isError).toBeUndefined();
  expect(same.store.getReportHarness(id(result, "msg"))!.checks[0]).toMatchObject({ command, workdir: null, execStatus: "matched" });
  const different = await setup(); different.put(different.workdir);
  expect((await different.post("pass")).isError).toBe(true);
});

test("명시 workdir와 실제 위치가 다르면 완료를 거절한다", async () => {
  const s = await setup(); s.put(s.workdir);
  expect((await s.post("pass", { workdir: s.member.cwd })).isError).toBe(true);
});

test("지원 진단도 저장된 workdir를 사용하며 원 위치·출력을 노출하지 않는다", async () => {
  const s = await setup(); s.put(s.workdir);
  const posted = await s.post("fail", { workdir: s.workdir });
  expect(posted.isError).toBeUndefined();
  const report = id(posted, "msg");
  const response = await s.tool(s.member, "exec_diagnose", { task_id: s.task, report_id: report, check_index: 0 });
  expect(response.isError).toBeUndefined();
  const d = JSON.parse(response.text);
  expect(d.selection).toMatchObject({ code: "selected", cwdMatch: true });
  expect(d.comparison.status).toBe("matched");
  expect(d.events.candidates[0]).toMatchObject({ commandMatch: true, cwdMatch: "match", proof: "ok", parsedExit: 0, inCurrentParser: true });
  expect(response.text).not.toContain(s.workdir);
});

for (const workdir of [null, "", "relative", "file:///fake/review", "file://remote.invalid/fake/review", "/fake/\u0000review", "/fake/\ud800", "/fake/\udc00", 3, {}]) test(`API는 잘못된 workdir ${JSON.stringify(workdir)}를 거절한다`, async () => {
  const s = await setup(); s.put(s.workdir);
  const before = s.store.listMessages(s.project.id).length;
  expect((await s.post("fail", { workdir })).isError).toBe(true);
  expect(s.store.listMessages(s.project.id).length).toBe(before);
});

test("v35의 기존 검사 행은 원 command를 유지하고 workdir NULL로 전환한다", () => {
  const path = join(mkdtempSync(join(tmpdir(), "harness-workdir-v35-")), "synthetic.db");
  const old = new Database(path, { create: true });
  try {
    for (const sql of MIGRATIONS.slice(0, 35)) old.exec(sql);
    old.exec("PRAGMA user_version = 35");
    old.query("INSERT INTO report_checks (message_id, idx, name, kind, result, evidence, command) VALUES (?, 0, ?, 'behavior', 'fail', ?, ?)").run("synthetic-old", "옛 검사", "합성 과거 행", command);
  } finally { old.close(); }
  const next = openDb(path, { migrationBackup: false });
  try {
    expect(next.query("SELECT command, workdir FROM report_checks WHERE message_id = 'synthetic-old'").get()).toEqual({ command, workdir: null });
    expect(next.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(MIGRATIONS.length);
  } finally { next.close(); }
});

test("a stored out-of-scope workdir never becomes completion or diagnostic success", async () => {
  const s = await setup(), outside = "/synthetic/unrelated-project";
  s.put(outside);
  expect((await s.post("pass", { workdir: outside })).isError).toBe(true);
  const failed = await s.post("fail", { workdir: outside });
  expect(failed.isError).toBeUndefined();
  const diagnostic = await s.tool(s.member, "exec_diagnose", { task_id: s.task, report_id: id(failed, "msg"), check_index: 0 });
  expect(diagnostic.isError).toBeUndefined();
  expect(JSON.parse(diagnostic.text).comparison.status).not.toBe("matched");
});
