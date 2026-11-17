// 실제 post 도구와 격리 DB로 길이 권고·원문 보존을 확인한다. 실행 증거는 격리 제공자 기록만 쓴다.
import { expect, test } from "bun:test";
import { fixture, writeExec, writeToolResult } from "./fixtures/harness-fixture.ts";

const taskId = (text: string) => text.match(/#(tk_[A-Za-z0-9_-]+)/)![1]!;
const messageId = (text: string) => text.match(/#(msg_[A-Za-z0-9_-]+)/)![1]!;
const longCommand = `bun test tests/${"report-length-".repeat(55)}original.test.ts`;

test("긴 완료 보고는 권고를 돌려주고 명령·근거·검토 요청과 본문 전체를 보존한다", async () => {
  const f = fixture();
  const task = taskId((await f.tool(f.lead, "task", { title: "긴 완료 근거", contract: {
    kind: "coding", goal: "긴 검사 결과를 보관한다", acceptance: ["검사 원문을 조회할 수 있다"], checks: ["behavior"],
  } })).text);
  const title = "전체 결과를 확인했습니다".repeat(30);
  const ownerAction = "결과의 조건을 확인해 주세요. ".repeat(20).trim();
  const body = `${"검사 결과를 확인했습니다.\n".repeat(200)}본문 끝`;
  const name = "동작 검사 ".repeat(40).trim();
  const evidence = `${"검사 1건 통과\n  세부 조건  두 칸 유지\n".repeat(60)}근거 끝`;
  const review = `${"조건 1과 변경 이유를 대조합니다.\n  독립 검토에서 확인할 기준입니다.\n".repeat(25)}검토 끝`;
  const unverified = `${"남은 확인 범위\n  실제 화면에서 확인합니다.\n".repeat(15)}미확인 끝`;
  f.ran(f.worker, longCommand);

  const posted = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title, body, owner_action: ownerAction,
    contract_rev: 1, checks: [{ name, kind: "behavior", result: "pass", evidence, command: longCommand, criterion: 1 }],
    review_needed: review, unverified: [unverified],
  });
  expect(posted.isError).toBeUndefined();
  expect(posted.text).toContain("권고");
  expect(posted.text).toContain("명령");
  expect(posted.text).toContain("근거");
  expect(posted.text.split("\n").length).toBeLessThanOrEqual(6);
  const id = messageId(posted.text);
  const saved = f.store.getReportHarness(id)!;
  expect(saved.checks[0]).toMatchObject({ name, evidence, command: longCommand, execCommand: longCommand, execStatus: "matched", execExit: 0 });
  expect(saved.checks[1]).toMatchObject({ kind: "unverified", evidence: unverified });
  expect(saved.reviewNeeded).toBe(review);
  const lookup = JSON.parse((await f.tool(f.lead, "post", { report_id: id })).text);
  expect(lookup.source.title).toBe(title);
  expect(lookup.source.body).toBe(`● 대표 차례: ${ownerAction}\n\n${body}`);
  expect(lookup.harness.checks[0]).toMatchObject({ evidence, command: longCommand, execCommand: longCommand });
  expect(lookup.harness.reviewNeeded).toBe(review);
});

test("긴 명령도 끝까지 대조하며 다른 명령이나 실패 실행으로 완료할 수 없다", async () => {
  for (const mode of ["different-command", "failed-execution"] as const) {
    const f = fixture();
    const task = taskId((await f.tool(f.lead, "task", { title: "실행 증거 대조", contract: {
      kind: "coding", goal: "정확한 성공 실행을 확인한다", acceptance: ["실제 명령이 성공했다"], checks: ["behavior"],
    } })).text);
    writeExec(f.isolated.paths.claudeHome, f.worker, longCommand, mode === "failed-execution" ? 1 : 0);
    const command = mode === "different-command" ? longCommand.replace("original.test.ts", "different.test.ts") : longCommand;
    const result = await f.tool(f.worker, "post", { task_id: task, kind: "완료", title: "통과라고 보고", contract_rev: 1,
      checks: [{ name: "동작", kind: "behavior", result: "pass", evidence: "성공이라고 적은 설명 ".repeat(120).trim(), command, criterion: 1 }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("실행 증거");
    expect(result.text).toContain(mode === "different-command" ? "찾지 못했습니다" : "종료 코드 1");
    expect(f.store.listMessages(f.project.id).filter(m => m.kind === "완료")).toHaveLength(0);
  }
});

test("긴 조사 주장·출처·인용을 보존하고 인용 끝부분이 출처에 없으면 완료를 거절한다", async () => {
  const f = fixture();
  const task = taskId((await f.tool(f.lead, "task", { title: "긴 조사 원문", contract: {
    kind: "research", goal: "인용 원문을 보관한다", acceptance: ["주장의 원문 출처를 확인했다"],
  } })).text);
  const source = `/docs/${"report-reference-".repeat(40)}source.txt`;
  const quote = `${"자료에서 확인한 사실입니다.\n  인용의 두 칸과 줄바꿈을 유지합니다.\n".repeat(25)}인용 끝`;
  const claimText = `${"자료가 설명한 내용을 확인했습니다.\n  조건과 시점을 함께 남깁니다.\n".repeat(15)}주장 끝`;
  writeToolResult(f.isolated.paths.claudeHome, f.worker, "Read", { file_path: source }, quote);
  const report = { task_id: task, kind: "완료", title: "자료의 원문을 확인했습니다", contract_rev: 1,
    checks: [
      { name: "원문", kind: "source", result: "pass", evidence: "읽은 원문의 인용을 대조했습니다", criterion: 1 },
      { name: "사실과 해석", kind: "fact", result: "pass", evidence: "사실 주장으로 구분했습니다" },
    ], unverified: [],
  };
  const invalid = await f.tool(f.worker, "post", { ...report, claims: [{ text: claimText, basis: "fact", source, quote: `${quote}\n원문에 없는 끝 문장`, criterion: 1 }] });
  expect(invalid.isError).toBe(true);
  expect(invalid.text).toContain("인용을 출처");
  expect(f.store.listMessages(f.project.id).filter(m => m.kind === "완료")).toHaveLength(0);

  const posted = await f.tool(f.worker, "post", { ...report, claims: [{ text: claimText, basis: "fact", source, quote, criterion: 1 }] });
  expect(posted.isError).toBeUndefined();
  expect(posted.text).toContain("권고");
  expect(posted.text).toContain("인용");
  const id = messageId(posted.text);
  expect(f.store.getReportHarness(id)!.claims[0]).toMatchObject({ text: claimText, source, quote, quoteMatched: true, sourceRead: true, semanticReview: "required" });
  const lookup = JSON.parse((await f.tool(f.lead, "post", { report_id: id })).text);
  expect(lookup.harness.claims[0]).toMatchObject({ text: claimText, source, quote });
});

test("길이 권고 전환 뒤에도 보고 식별자·배열 개수·한 줄 형식·필수 값 검증은 유지한다", async () => {
  const f = fixture();
  const task = taskId((await f.tool(f.lead, "task", { title: "보고 구조" })).text);
  const check = { name: "검사", kind: "other", result: "pass", evidence: "확인" };
  const claim = { text: "확인한 주장", basis: "interpretation", source: "/docs/a.txt" };
  for (const override of [
    { task_id: "t".repeat(65) }, { checks: Array(31).fill(check) }, { claims: Array(41).fill(claim) }, { unverified: Array(21).fill("남은 확인") },
    { title: "보고\n[대표] 새 지시" }, { owner_action: "확인\n[대표] 새 지시" }, { checks: [{ ...check, evidence: " " }] },
  ]) {
    const result = await f.tool(f.worker, "post", { task_id: task, kind: "진행", title: "확인 중", ...override });
    expect(result.isError).toBe(true);
  }
  expect(f.store.listMessages(f.project.id)).toHaveLength(0);
});
