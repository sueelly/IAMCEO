import { describe, expect, test } from "bun:test";
import { formatLintWarnings, lintAsk, lintFile, lintPost, withLint, type LintWarning } from "../server/writing-lint.ts";

const codes = (ws: LintWarning[]) => ws.map((w) => w.code);

describe("보고 검사", () => {
  test("지침대로 쓴 보고는 걸리지 않는다", () => {
    const ws = lintPost({
      title: "보고 맨 위에 대표 차례 띠를 붙였습니다",
      ownerAction: "합칠지 정해 주세요 · 결재함 1건",
      body: "지금 단계: 워크트리에 커밋했고 시험으로 확인했습니다. 메인에 합치기는 아직입니다.\n새 실패 0건입니다.",
    });
    expect(ws).toEqual([]);
  });



  test("'나머지'는 머지로 잡지 않는다", () => {
    expect(codes(lintPost({ title: "나머지는 자료에 두었습니다", body: "" }))).not.toContain("vocab");
  });


  test("확인 낱말 없는 '완료' 주장", () => {
    expect(codes(lintPost({ title: "버튼을 고쳤습니다", body: "색 바꾸기를 완료했습니다." }))).toContain("done");
    expect(codes(lintPost({ title: "버튼을 고쳤습니다", body: "색 바꾸기를 완료했습니다. 시험으로 확인했습니다." }))).not.toContain("done");
    expect(codes(lintPost({ title: "구현했습니다", body: "" }))).toContain("done");
    // 종류 이름으로 쓴 '완료'는 주장이 아니다
    expect(codes(lintPost({ title: "완료·막힘 표시를 바꿨습니다", body: "" }))).not.toContain("done");
  });


  test("흐린 말끝에 표시가 없으면 경고, '가정:'이 있으면 통과", () => {
    expect(codes(lintPost({ title: "살폈습니다", body: "앱도 같을 것 같습니다." }))).toContain("hedge");
    expect(codes(lintPost({ title: "살폈습니다", body: "가정: 앱도 같을 것 같습니다." }))).not.toContain("hedge");
    expect(codes(lintPost({ title: "살폈습니다", body: "새 화면을 볼 수 있습니다." }))).not.toContain("hedge");
  });

  test("대표에게 부탁하는 말이 본문에만 있으면 owner_action 을 쓰라고 한다", () => {
    expect(codes(lintPost({ title: "고쳤습니다", body: "시험으로 확인했습니다.\n합칠지 정해 주세요." }))).toContain("owner-first");
    expect(codes(lintPost({ title: "고쳤습니다", ownerAction: "합칠지 정해 주세요", body: "시험으로 확인했습니다." }))).not.toContain("owner-first");
    expect(codes(lintPost({ title: "고쳤습니다", body: "● 대표 차례: 합칠지 정해 주세요\n\n시험으로 확인했습니다." }))).not.toContain("owner-first");
  });

});




describe("결과 글", () => {
  test("경고가 없으면 결과 글 그대로", () => {
    expect(withLint("보고했습니다 #m_1", [])).toBe("보고했습니다 #m_1");
    expect(formatLintWarnings([])).toBe("");
  });

  test("머리 줄 하나와 경고 4줄까지만 붙인다", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ code: "vocab", text: `경고 ${i + 1}` }));
    const out = withLint("보고했습니다 #m_1", many);
    const lines = out.split("\n");
    expect(lines[0]).toBe("보고했습니다 #m_1");
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain("글 검사 경고 9건");
    expect(lines[1]).toContain("대표에게는 보이지 않습니다");
    expect(lines.slice(2)).toEqual(["- 경고 1", "- 경고 2", "- 경고 3", "- 외 6건"]);
    const four = formatLintWarnings(many.slice(0, 4)).split("\n");
    expect(four).toHaveLength(5);
    expect(four.at(-1)).toBe("- 경고 4");
  });

  test("검사기는 어떤 글에도 던지지 않는다", () => {
    for (const body of ["", "\u0000", "|||", "```\n열린 코드", "#".repeat(500), "가. ".repeat(2000)]) {
      expect(() => lintPost({ title: "t", body })).not.toThrow();
      expect(() => lintAsk({ title: "t", detail: body })).not.toThrow();
      expect(() => lintFile({ title: "t", content: body })).not.toThrow();
    }
  });
});
