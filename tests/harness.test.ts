// 공통 하네스: 업무 시작 계약 → 직원 실행 → 필수 검사 → 근거 있는 완료 보고.
// 격리 데이터·가짜 core 실행기로 본다. 실제 직원·대표 화면·운영 DB 에는 아무것도 보내지 않는다.
import { expect, test } from "bun:test";
import { CODING, fixture, pass, until, writeToolResult } from "./fixtures/harness-fixture.ts";
test("업무 한 건 전 과정: 계약이 지시에 실리고, 검사 없는·실패한 완료는 거절되며, 통과한 완료는 실행·계약 판과 함께 총괄에게 간다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "검사 줄 보이기" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  const assigned = await f.tool(f.lead, "team_assign", { member: "w1", text: "검사 줄을 보이게 고쳐 주세요", task_id: task, contract: CODING });
  expect(assigned.isError).toBeUndefined();
  await until("직원 지시", () => f.runner.to(f.worker).some(t => t.includes("업무 계약 r1")));
  const delivered = f.runner.to(f.worker).find(t => t.includes("업무 계약 r1"))!;
  for (const part of ["원하는 결과: 보고 화면에 검사 줄을 보인다", "합격 기준 1: 완료 보고 아래에", "합격 기준 2: 검사가 없으면", "자율 범위: server/ 안에서만", "금지: 깃허브에 올리지 않는다", "필요한 증거: 시험 이름과 통과 수", "필수 검사: behavior(관련 동작 시험), typecheck(코드 검사), regression(회귀 시험), real(실제 화면·실행 증거)"]) expect(delivered).toContain(part);

  // 검사 없는 완료 → 거절(글이 남지 않는다)
  const bare = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "고쳤습니다" });
  expect(bare.isError).toBe(true);
  expect(bare.text).toContain("관련 동작 시험(behavior) 검사가 없습니다");
  expect(bare.text).toContain("contract_rev 로 밝히지 않았습니다(지금 판 r1)");
  expect(bare.text).toContain("합격 기준 1(");
  // 코드 검사 실패가 남은 완료 → 거절
  const failing = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "고쳤습니다", contract_rev: 1, checks: [pass("behavior", 1), { name: "tsc", kind: "typecheck", result: "fail", evidence: "오류 2건" }, pass("regression", 2), pass("real", 1)] });
  expect(failing.isError).toBe(true);
  expect(failing.text).toContain("'tsc' 검사가 실패했습니다");
  // 실행 안 함은 통과가 아니다
  const skipped = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "고쳤습니다", contract_rev: 1, checks: [pass("behavior", 1), pass("typecheck"), pass("regression", 2), { name: "화면", kind: "real", result: "not_run", evidence: "브라우저 없음" }] });
  expect(skipped.isError).toBe(true);
  expect(skipped.text).toContain("실제 화면·실행 증거(real)이 통과하지 않았습니다(실행 안 함)");
  expect(f.store.listMessages(f.project.id).filter(m => m.kind === "완료")).toHaveLength(0);
  // 막힘은 실패를 안고도 받는다
  const blocked = await f.tool(f.worker, "post", { task_id: task, kind: "막힘", title: "코드 검사 실패", checks: [{ name: "tsc", kind: "typecheck", result: "fail", evidence: "오류 2건" }], unverified: ["화면 확인"] });
  expect(blocked.isError).toBeUndefined();
  // 세션 기록이 없으면 통과 증거가 없다(막지 않고 넘기지 않는다)
  const noLog = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "고쳤습니다", contract_rev: 1, checks: [pass("behavior", 1), pass("typecheck"), pass("regression", 2), pass("real", 1)], unverified: [] });
  expect(noLog.text).toContain("세션 실행 기록을 찾지 못했습니다(log_not_found)");
  // 통과라고 적어도 세션 실행 기록에 그 명령이 없으면 받지 않는다
  f.ran(f.worker, "ls");
  const unproven = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "고쳤습니다", contract_rev: 1, checks: [pass("behavior", 1), pass("typecheck"), pass("regression", 2), pass("real", 1)], unverified: [] });
  expect(unproven.isError).toBe(true);
  expect(unproven.text).toContain("'bun test behavior'을 계약 뒤 실행 기록에서 찾지 못했습니다");
  // 고쳐서 다시 검사한 완료 → 받음
  f.ran(f.worker, "bun test behavior", "bun test typecheck", "cd server && bun test regression");
  const done = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "검사 줄을 보이게 고침", contract_rev: 1, checks: [pass("behavior", 1), pass("typecheck"), { ...pass("regression", 2), command: "cd server && bun test regression" }, pass("real", 1)], unverified: [], review_needed: "server/harness.ts 의 판정 규칙을 다른 직원이 계약 기준 1·2로 확인" });
  expect(done.isError).toBeUndefined();
  const id = done.text.match(/#(msg_[A-Za-z0-9_-]+)/)![1]!;
  // 총괄은 앞 보고(막힘)를 받는 중이라 이 보고는 대기열에 있다. 전달 글을 본다.
  const report = f.store.listDeliveries().find(d => d.memberId === f.lead.id && d.kind === "report" && d.text.includes(id))!.text;
  expect(report).toContain("검사(작성자 보고, 계약 r1): behavior 통과(실행 기록 대조: 종료 0) · typecheck 통과(실행 기록 대조: 종료 0) · regression 통과(실행 기록 대조: 종료 0) · real 통과 · 미확인 항목 통과");
  expect(report).toContain("독립 검토 필요: server/harness.ts 의 판정 규칙");
  const lookup = JSON.parse((await f.tool(f.lead, "post", { report_id: id })).text);
  expect(lookup.harness).toMatchObject({ contractTaskId: task, contractRev: 1, contractRevNow: 1, memberId: f.worker.id, reviewNeeded: expect.stringContaining("다른 직원") });
  expect(lookup.harness.checks.map((c: { kind: string; criterion: number | null }) => [c.kind, c.criterion])).toEqual([["behavior", 1], ["typecheck", null], ["regression", 2], ["real", 1], ["unverified", null]]);
  expect(lookup.harness.checks[0]).toMatchObject({ taskId: task, who: "철수", command: "bun test behavior", execStatus: "matched", execExit: 0, execCommand: "bun test behavior" });
  expect(lookup.harness.checks[2]).toMatchObject({ execStatus: "matched", execCommand: "cd server && bun test regression" });
  expect(lookup.harness.checks[3]).toMatchObject({ execStatus: "not_required" });
  expect(lookup.harness).toMatchObject({ gate: "contract", evidenceStatus: "ok" });
});

test("총괄의 완료는 그 계약 판으로 통과한 직원 완료 보고가 있어야 받고, 계약이 바뀌면 다시 막힌다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "총괄 완료 판정", contract: { ...CODING, checks: ["behavior"], acceptance: ["동작한다"] } })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  expect((await f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "끝났습니다" })).text).toContain("계약 r1 로 검사를 통과한 직원 완료 보고가 아직 없습니다");
  f.ran(f.worker, "bun test behavior");
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "동작함", contract_rev: 1, checks: [pass("behavior", 1)] })).isError).toBeUndefined();
  expect((await f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "끝났습니다" })).isError).toBeUndefined();
  // 총괄이 자기 검사를 붙이면 총괄 세션 기록과 대조한다(직원의 실행을 빌려 쓰지 못한다)
  f.ran(f.lead, "ls");
  expect((await f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "총괄도 봄", contract_rev: 1, checks: [pass("behavior", 1)] })).text).toContain("실행 기록에서 찾지 못했습니다");
  // 총괄이 기준을 바꾸면 새 판이다. 옛 판의 통과는 새 판의 완료 근거가 아니다.
  expect((await f.tool(f.lead, "task", { task_id: task, contract: { ...CODING, checks: ["behavior"], acceptance: ["동작한다", "문서도 고친다"] } })).text).toContain("업무 계약 r2");
  expect((await f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "끝났습니다" })).text).toContain("계약 r2 로 검사를 통과한 직원 완료 보고가 아직 없습니다");
});

test("조사 업무: 출처·사실과 해석·미확인이 없는 완료는 거절하고, 갖춘 결과 한 건은 받는다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "CLI 훅 조사", contract: { kind: "research", goal: "직원 CLI 별 훅 지원을 정리한다", acceptance: ["주장마다 원문 출처가 있다", "사실과 해석이 갈린다"] } })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  const thin = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "조사 끝", contract_rev: 1, checks: [{ name: "정리", kind: "fact", result: "pass", evidence: "표 1개", criterion: 2 }] });
  expect(thin.isError).toBe(true);
  expect(thin.text).toContain("주장별 원문 출처(source) 검사가 없습니다");
  expect(thin.text).toContain("미확인 항목(unverified) 검사가 없습니다");
  const checks = [
    { name: "주장 3개의 출처", kind: "source", result: "pass", evidence: "claude --help 2.1.323 · codex --help 0.167.0 · agy --help 1.5.8", criterion: 1 },
    { name: "사실/해석 표시", kind: "fact", result: "pass", evidence: "표의 '확정'·'해석' 열", criterion: 2 },
  ];
  // 주장(claims) 없이는 조사 완료가 아니다
  const noClaims = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "조사 끝", contract_rev: 1, checks, unverified: ["Codex 훅의 실행 시 신뢰 절차"] });
  expect(noClaims.text).toContain("claims(주장·사실/해석·출처·원문 인용)가 1개 이상");
  // 직원이 실제로 본 도구 결과(계약 뒤)에 인용이 있어야 사실로 받는다
  writeToolResult(f.isolated.paths.claudeHome, f.worker, "Read", { file_path: "/docs/other.txt" }, "다른 글");
  const fact = { text: "Claude 는 --settings 로 훅을 받는다", basis: "fact", source: "/docs/claude-help.txt", quote: "--settings <file-or-json>  Load additional settings", criterion: 1 };
  const seenNothing = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "조사 끝", contract_rev: 1, checks, claims: [fact], unverified: [] });
  expect(seenNothing.text).toContain("인용을 출처 '/docs/claude-help.txt'를 연 계약 뒤 도구 결과나 자료 본문에서 찾지 못했습니다");
  // echo 로 인용을 직접 쓴 것은 본 것이 아니다
  writeToolResult(f.isolated.paths.claudeHome, f.worker, "Bash", { command: `echo '--settings <file-or-json>  Load additional settings' # /docs/claude-help.txt` }, "--settings <file-or-json>  Load additional settings");
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "조사 끝", contract_rev: 1, checks, claims: [fact], unverified: [] })).isError).toBe(true);
  writeToolResult(f.isolated.paths.claudeHome, f.worker, "Read", { file_path: "/docs/claude-help.txt" }, "Options:\n  --settings <file-or-json>  Load additional settings from a JSON file\n");
  writeToolResult(f.isolated.paths.claudeHome, f.worker, "Read", { file_path: "/docs/codex-hooks.txt" }, "Codex hook support: fixture source.\n");
  const full = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "직원 CLI 훅 지원을 정리함", contract_rev: 1, checks,
    claims: [fact, { text: "Codex 훅은 Claude 보다 막는 범위가 좁아 보인다", basis: "interpretation", source: "/docs/codex-hooks.txt" }], unverified: ["Codex 훅의 실행 시 신뢰 절차"] });
  expect(full.isError).toBeUndefined();
  const harness = f.store.getReportHarness(full.text.match(/#(msg_[A-Za-z0-9_-]+)/)![1]!)!;
  expect(harness.claims.map(c => [c.basis, c.verified, c.quoteMatched, c.sourceRead, c.semanticReview])).toEqual([["fact", false, true, true, "required"], ["interpretation", false, false, true, "required"]]);
});

test("같은 업무를 다른 직원에게 넘기면 계약 판·지난 검사(보고 id·누가)가 실리고, 직원은 총괄 계약을 바꾸지 못한다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "두 직원 업무" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  await f.tool(f.lead, "team_assign", { member: "w1", text: "첫 부분", task_id: task, contract: { ...CODING, checks: ["behavior"], acceptance: ["동작한다"] } });
  const first = await f.tool(f.worker, "post", { task_id: task, kind: "막힘", title: "절반만 됨", checks: [{ name: "동작", kind: "behavior", result: "fail", evidence: "1 fail", criterion: 1 }] });
  const firstId = first.text.match(/#(msg_[A-Za-z0-9_-]+)/)![1]!;
  await f.tool(f.lead, "team_assign", { member: "w2", text: "이어서 마저", task_id: task });
  await until("두 번째 직원 지시", () => f.runner.to(f.worker2).some(t => t.includes("업무 계약 r1")));
  const second = f.runner.to(f.worker2).find(t => t.includes("업무 계약 r1"))!;
  expect(second).toContain(`지난 검사(보고 #${firstId}, 철수, 계약 r1): 동작 실패`);
  // 지시에는 계약·지난 검사만 실린다. 첫 직원이 받은 지시 원문은 넘어가지 않는다.
  expect(second).not.toContain("첫 부분");
  const changed = await f.tool(f.worker2, "task", { task_id: task, contract: { kind: "other", goal: "대충", acceptance: ["아무거나"] } });
  expect(changed.isError).toBe(true);
  expect(changed.text).toContain("직원은 바꾸거나 덮지 않습니다");
  expect(f.store.getTaskContract(task)!.rev).toBe(1);
});

test("계약 없는 업무의 완료는 지금처럼 검사 없이 받는다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "옛 방식 업무" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "끝" })).isError).toBeUndefined();
  expect(f.store.getTaskContract(task)).toBeNull();
});

// ---- 검토 지적(독립 검토 1차) 반례. 고치기 전(8c7bf66)에는 모두 '받음'이었다. ----

test("검토 반례 1: 계약 업무를 받은 턴에 계약 없는 다른 업무·새 업무·자기 계약 업무로 완료를 올리면 거절한다", async () => {
  const f = fixture();
  const gated = (await f.tool(f.lead, "task", { title: "계약 업무" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  const free = (await f.tool(f.lead, "task", { title: "계약 없는 업무" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  await f.tool(f.lead, "team_assign", { member: "w1", text: "해 주세요", task_id: gated, contract: { ...CODING, checks: ["behavior"], acceptance: ["동작한다"] } });
  await until("직원 지시", () => f.runner.to(f.worker).some(t => t.includes("업무 계약 r1")));
  const other = await f.tool(f.worker, "post", { task_id: free, kind: "완료", title: "계약 업무 끝" });
  expect(other.isError).toBe(true);
  expect(other.text).toContain(`받은 업무(#${gated} 계약 r1)는 계약이 있고 아직 완료·막힘으로 마감하지 않았습니다`);
  const fresh = (await f.tool(f.worker, "task", { title: "내가 만든 업무" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  expect((await f.tool(f.worker, "post", { task_id: fresh, kind: "완료", title: "새 업무로 끝" })).isError).toBe(true);
  const self = (await f.tool(f.worker, "task", { title: "자기 계약", contract: { kind: "other", goal: "x", acceptance: ["됨"], checks: [] } })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  expect((await f.tool(f.worker, "post", { task_id: self, kind: "완료", title: "됨", contract_rev: 1, checks: [{ name: "봄", kind: "other", result: "pass", evidence: "봄", criterion: 1 }] })).isError).toBe(true);
  expect(f.store.listMessages(f.project.id).filter(m => m.kind === "완료")).toHaveLength(0);
  // 진행·알림·막힘은 그대로 받는다
  expect((await f.tool(f.worker, "post", { task_id: free, kind: "알림", title: "따로 본 것" })).isError).toBeUndefined();
});

test("검토 반례 1: 갈래 업무는 위 업무의 계약을 따르고, 직원은 갈래에 느슨한 계약을 덮지 못한다. 갈래의 통과 완료는 총괄의 위 업무 완료를 연다", async () => {
  const f = fixture();
  const gated = (await f.tool(f.lead, "task", { title: "계약 업무", contract: { ...CODING, checks: ["behavior"], acceptance: ["동작한다"] } })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  const child = (await f.tool(f.worker, "task", { title: "갈래", parent_task_id: gated })).text;
  expect(child).toContain(`업무 계약 r1 (#${gated}`);
  const childId = child.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  const bare = await f.tool(f.worker, "post", { task_id: childId, kind: "완료", title: "갈래에서 끝" });
  expect(bare.isError).toBe(true);
  expect(bare.text).toContain(`업무 #${gated} 계약 r1`);
  expect(bare.text).toContain(`갈래 업무 #${childId} 는 위 업무 #${gated} 의 계약을 그대로 따른다`);
  const loose = await f.tool(f.worker, "task", { title: "느슨한 갈래", parent_task_id: gated, contract: { kind: "other", goal: "x", acceptance: ["아무거나"], checks: [] } });
  expect(loose.isError).toBe(true);
  expect(loose.text).toContain("이 계약을 이어받습니다");
  expect((await f.tool(f.worker, "task", { task_id: childId, contract: { kind: "other", goal: "x", acceptance: ["아무거나"], checks: [] } })).isError).toBe(true);
  expect((await f.tool(f.lead, "post", { task_id: gated, kind: "완료", title: "끝" })).isError).toBe(true);
  f.ran(f.worker, "bun test behavior");
  const done = await f.tool(f.worker, "post", { task_id: childId, kind: "완료", title: "갈래에서 끝", contract_rev: 1, checks: [pass("behavior", 1)] });
  expect(done.isError).toBeUndefined();
  const id = done.text.match(/#(msg_[A-Za-z0-9_-]+)/)![1]!;
  expect(f.store.getReportHarness(id)).toMatchObject({ contractTaskId: gated, contractRev: 1 });
  expect((await f.tool(f.lead, "post", { task_id: gated, kind: "완료", title: "끝" })).isError).toBeUndefined();
});

test("검토 반례 1: 이미 여러 업무를 받은 옛 실행을 복원해도 계약 업무와 계약 없는 업무를 각각 판정해 완료할 수 있다", async () => {
  const f = fixture();
  const gated = (await f.tool(f.lead, "task", { title: "계약 업무" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  const free = (await f.tool(f.lead, "task", { title: "계약 없는 업무" })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  await f.tool(f.lead, "team_assign", { member: "w1", text: "먼저 이것", task_id: free });
  await until("첫 지시", () => f.runner.to(f.worker).length === 1);
  await f.tool(f.lead, "team_assign", { member: "w1", text: "계약 일", task_id: gated, contract: { ...CODING, checks: ["behavior"], acceptance: ["동작한다"] } });
  await f.tool(f.lead, "team_assign", { member: "w1", text: "이것도", task_id: free });
  // 새 전달은 업무 순서를 지킨다. 이미 두 업무를 받았던 옛 실행의
  // 영수증·실행 기록을 복원해, 진행 중인 실행의 완료 판정을 검증한다.
  const run = f.store.listPendingExecutions().find(r => r.memberId === f.worker.id)!;
  const received = f.store.listPending(f.worker.id).filter(d => d.kind === "instruction");
  expect(received).toHaveLength(2);
  for (const delivery of received) f.store.markDelivered(delivery.id);
  f.store.saveExecutionJournal({ ...run, deliveryIds: [...run.deliveryIds, ...received.map(d => d.id)] });
  const batch = received.map(d => d.text).join("\n\n");
  expect(batch).toContain("업무 계약 r1");
  expect(batch).toContain(`작업 #${free}`);
  expect((await f.tool(f.worker, "post", { task_id: free, kind: "완료", title: "계약 없는 일 끝" })).isError).toBeUndefined();
  f.ran(f.worker, "bun test behavior");
  expect((await f.tool(f.worker, "post", { task_id: gated, kind: "완료", title: "계약 일 끝", contract_rev: 1, checks: [pass("behavior", 1)] })).isError).toBeUndefined();
});

test("검토 반례 2: 판이 바뀌면 옛 판 번호의 검사는 기준 수가 같아도 받지 않는다. 판을 밝히지 않은 완료도 받지 않는다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "판 변경", contract: { ...CODING, checks: ["behavior"], acceptance: ["옛 기준"] } })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  expect((await f.tool(f.lead, "task", { task_id: task, contract: { ...CODING, checks: ["behavior"], acceptance: ["새 기준"] } })).text).toContain("업무 계약 r2");
  const old = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "옛 기준으로 끝", contract_rev: 1, checks: [pass("behavior", 1)] });
  expect(old.isError).toBe(true);
  expect(old.text).toContain("계약이 r1 에서 r2 로 바뀌었습니다");
  expect(old.text).toContain("합격 기준 1: 새 기준");
  const unnamed = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "판 안 밝힘", checks: [pass("behavior", 1)] });
  expect(unnamed.isError).toBe(true);
  expect(unnamed.text).toContain("contract_rev 로 밝히지 않았습니다(지금 판 r2)");
  // 옛 판의 막힘 검사는 그 판으로 남는다(새 판으로 올려 붙이지 않는다)
  const blocked = await f.tool(f.worker, "post", { task_id: task, kind: "막힘", title: "옛 판에서 막힘", contract_rev: 1, checks: [{ name: "동작", kind: "behavior", result: "fail", evidence: "1 fail", criterion: 1 }] });
  expect(f.store.getReportHarness(blocked.text.match(/#(msg_[A-Za-z0-9_-]+)/)![1]!)!.contractRev).toBe(1);
  expect((await f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "끝" })).isError).toBe(true);
  f.ran(f.worker, "bun test behavior");
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "새 기준으로 끝", contract_rev: 2, checks: [pass("behavior", 1)] })).isError).toBeUndefined();
});

test("검토 작은 지적: 통과와 실행 안 함이 섞인 완료는 거절한다. 계약 작성자는 이름이 아니라 직원 id 로 가르고, 직원 작성 계약은 그렇게 보인다", async () => {
  const f = fixture();
  const task = (await f.tool(f.lead, "task", { title: "섞임", contract: { ...CODING, checks: ["behavior"], acceptance: ["동작한다"] } })).text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  const mixed = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "섞임", contract_rev: 1, checks: [pass("behavior", 1), { name: "화면", kind: "behavior", result: "not_run", evidence: "못 봄", criterion: 1 }] });
  expect(mixed.isError).toBe(true);
  expect(mixed.text).toContain("'화면' 검사를 실행하지 않았습니다");
  // 작성자는 직원 id 로 가른다: 계약을 단 뒤 이름이 바뀌면, 그 이름을 새로 쓰는 다른 직원은 고치지 못하고 본인은 고친다
  const self = (await f.tool(f.worker, "task", { title: "자기 계약", contract: { kind: "other", goal: "x", acceptance: ["됨"], checks: [] } })).text;
  expect(self).toContain("작성 철수, 직원 작성 계약");
  const selfId = self.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
  f.store.patchMember(f.worker.id, { name: "민수" });
  const twin = f.make("w3", "철수", "worker");
  expect((await f.tool(twin, "task", { task_id: selfId, contract: { kind: "other", goal: "y", acceptance: ["아무거나"], checks: [] } })).isError).toBe(true);
  expect(f.store.getTaskContract(selfId)).toMatchObject({ rev: 1, authorMemberId: f.worker.id, authorKind: "worker" });
  expect((await f.tool(f.worker, "task", { task_id: selfId, contract: { kind: "other", goal: "x", acceptance: ["됨", "화면도 봄"], checks: [] } })).isError).toBeUndefined();
  expect(f.store.getTaskContract(selfId)!.rev).toBe(2);
  // 자기 계약 업무의 완료가 총괄에게 갈 때 '직원 작성 계약'으로 보인다
  const done = await f.tool(f.worker, "post", { task_id: selfId, kind: "완료", title: "됨", contract_rev: 2, checks: [{ name: "봄", kind: "other", result: "pass", evidence: "화면 1장", criterion: 1 }, { name: "화면", kind: "other", result: "pass", evidence: "화면 2장", criterion: 2 }] });
  expect(done.isError).toBeUndefined();
  const id = done.text.match(/#(msg_[A-Za-z0-9_-]+)/)![1]!;
  const report = f.store.listDeliveries().find(d => d.memberId === f.lead.id && d.kind === "report" && d.text.includes(id))!.text;
  expect(report).toContain("검사(작성자 보고, 계약 r2(직원 작성 계약)): 봄 통과 · 화면 통과");
  expect(report).toContain("하네스: 확인 전 직원 계약(완료 판정 밖");
});
