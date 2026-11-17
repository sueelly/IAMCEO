import { expect, test } from "bun:test";
import { lintAsk, lintFile, lintPost, lintStatus } from "../server/writing-lint.ts";

const title = "IAMCEO의 결재 요청에서 업무명과 원래 요청을 확인할 수 있도록 보고 지침을 수정했습니다";
const body = "IAMCEO의 결재 요청에 업무명과 원래 요청을 추가했고, 담당 직원이 무엇을 확인하지 못했는지와 대표가 결정할 내용을 같은 본문에서 읽을 수 있도록 수정했습니다.\n\n**구현과 검사:** 회귀 테스트 12개가 통과했습니다. 근거는 커밋 a1b2c3d의 tests/report-context.test.ts입니다.\n\n**운영 배포:** 운영 서버에는 아직 배포하지 않았습니다. 서비스 재시작 전 승인이 필요합니다.";

test("구체적인 대상·조건·검증 근거를 길이·강조 개수·기술 용어 때문에 삭제하라고 하지 않는다", () => {
  for (const warnings of [lintPost({ title, body }), lintAsk({ title, detail: body, recReason: "원문 요청을 보존해야 며칠 뒤에도 결재 내용을 이해할 수 있으므로 업무명과 요청 내용을 함께 보여 주는 안을 권합니다." }), lintFile({ title, content: body })]) {
    expect(warnings.filter(w => ["length-title", "length-sentence", "bold", "vocab", "codeish", "reflect"].includes(w.code))).toEqual([]);
  }
});

test("설명 없는 원ID·원 지시를 참조하는 글에는 구체적인 누락 내용을 안내한다", () => {
  const detail = "현재: 확인 대기\n남은 조건: 실제 원ID의 분기와 필요한 최소 진단\n원 지시와 최근 보고를 확인해 주세요.";
  for (const warnings of [lintPost({ title: "후속 실행 확인", body: detail }), lintAsk({ title: "후속 실행 확인", detail }), lintFile({ title: "후속 실행 확인", content: detail })]) {
    expect(warnings.some(w => w.code === "context-reference")).toBe(true);
    expect(warnings.map(w => w.text).join("\n")).toContain("무엇의 식별자");
  }
});

test("대상 이름과 설명이 있는 식별자는 모호한 참조로 판단하지 않는다", () => {
  const warnings = lintPost({ title: "IAMCEO 로그인 재개 오류를 조사했습니다", body: "IAMCEO 로그인 재개 업무의 원ID는 전달 ID dl_12345678입니다. 대표 요청은 ‘로그인 재개 오류의 원인을 조사해 주세요’입니다. 해당 전달의 수신 기록을 확인했습니다." });
  expect(warnings.filter(w => w.code.startsWith("context"))).toEqual([]);
});


test("팀 상태는 무엇을 확인하는지 없는 상태명에 맥락을 요청하고 구체적인 업무는 그대로 받는다", () => {
  expect(lintStatus({ now: "확인 대기" }).map(w => w.code)).toContain("context-subject");
  expect(lintStatus({ now: "IAMCEO 로그인 재개 실패의 전달 기록을 대조합니다.", next: "총괄이 로그인 재개 검사를 맡길 직원을 정합니다." })).toEqual([]);
});
