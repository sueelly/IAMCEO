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

  test("제목 45자, 대표 차례 40자, 설명 60자, 요청 40자를 넘으면 경고", () => {
    const long = "가".repeat(46);
    const ws = lintPost({ title: long, ownerAction: "나".repeat(41), body: `${"다".repeat(61)}입니다.\n${"라".repeat(39)} 해 주세요.` });
    const texts = ws.map((w) => w.text).join("\n");
    expect(texts).toContain("보고 제목 45자 넘음(46자)");
    expect(texts).toContain("대표 차례 40자 넘음(41자)");
    expect(texts).toContain("설명 문장 60자 넘음");
    expect(texts).toContain("요청 문장 40자 넘음");
  });

  test("용어·코드 무늬·굵은 글씨", () => {
    const ws = lintPost({
      title: "웹을 고쳤습니다",
      body: "테스트로 확인했고 머지했습니다. **첫째** **둘째**\n바뀐 곳은 server/agent-tools.ts 와 a1b2c3d4e5 커밋입니다.",
    });
    const texts = ws.map((w) => w.text).join("\n");
    expect(texts).toContain("'테스트' 대신 '시험'");
    expect(texts).toContain("'머지' 대신 '합치기'");
    expect(texts).toContain("굵은 글씨 2개(보고 한도 1)");
    expect(texts).toContain("파일 이름");
    expect(texts).toContain("커밋 해시");
  });

  test("'나머지'는 머지로 잡지 않는다", () => {
    expect(codes(lintPost({ title: "나머지는 자료에 두었습니다", body: "" }))).not.toContain("vocab");
  });

  test("짧은 보고의 제목·굵은 머리말", () => {
    expect(codes(lintPost({ title: "답", body: "## 결과\n시험으로 확인했습니다." }))).toContain("heading");
    expect(codes(lintPost({ title: "답", body: "**결과:**\n시험으로 확인했습니다." }))).toContain("heading");
  });

  test("확인 낱말 없는 '완료' 주장", () => {
    expect(codes(lintPost({ title: "버튼을 고쳤습니다", body: "색 바꾸기를 완료했습니다." }))).toContain("done");
    expect(codes(lintPost({ title: "버튼을 고쳤습니다", body: "색 바꾸기를 완료했습니다. 시험으로 확인했습니다." }))).not.toContain("done");
    expect(codes(lintPost({ title: "구현했습니다", body: "" }))).toContain("done");
    // 종류 이름으로 쓴 '완료'는 주장이 아니다
    expect(codes(lintPost({ title: "완료·막힘 표시를 바꿨습니다", body: "" }))).not.toContain("done");
  });

  test("'반영'은 대표 화면 뜻으로만", () => {
    expect(codes(lintPost({ title: "고쳤습니다", body: "의견을 반영했습니다. 시험으로 확인했습니다." }))).toContain("reflect");
    expect(codes(lintPost({ title: "고쳤습니다", body: "대표 화면에 반영했습니다. 열어서 확인했습니다." }))).not.toContain("reflect");
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

  test("경고는 대표 차례가 먼저, 문장 길이가 나중", () => {
    const ws = lintPost({ title: "고쳤습니다", body: `${"가".repeat(70)}입니다. 시험으로 확인했습니다.\n정해 주세요.` });
    expect(ws[0]!.code).toBe("owner-first");
    expect(ws.at(-1)!.code).toBe("length-sentence");
  });

  test("보고 근거의 길이 권고를 한 줄로 묶고 긴 원문을 경고에 복사하지 않는다", () => {
    const input = { title: "확인 결과", checks: [{ name: "가".repeat(200), evidence: "나".repeat(1000), command: "x".repeat(500) }],
      claims: [{ text: "다".repeat(400), source: "s".repeat(500), quote: "라".repeat(600) }], unverified: ["마".repeat(300)], reviewNeeded: "바".repeat(600) };
    expect(lintPost(input)).toEqual([]);
    const warnings = lintPost({ ...input,
      checks: input.checks.map(c => ({ name: `${c.name}가`, evidence: `${c.evidence}나`, command: `${c.command}x` })),
      claims: input.claims.map(c => ({ text: `${c.text}다`, source: `${c.source}s`, quote: `${c.quote}라` })),
      unverified: [`${input.unverified[0]}마`], reviewNeeded: `${input.reviewNeeded}바`,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("length-report");
    for (const field of ["검사 이름", "검사 근거", "명령", "주장", "출처", "인용", "미확인", "검토 요청"]) expect(warnings[0]!.text).toContain(field);
    expect(warnings[0]!.text).toContain("권고");
    expect(warnings[0]!.text).toContain("원문");
    expect(warnings[0]!.text).not.toContain("x".repeat(20));
    expect(warnings[0]!.text).not.toContain("\n");
  });
});

describe("결재 카드 검사", () => {
  test("카드 제목은 40자, 권장 이유는 60자", () => {
    const texts = lintAsk({ title: `${"가".repeat(40)}까요?`, detail: "확정: 사실입니다.", recReason: "나".repeat(61), recLabel: "가" }).map((w) => w.text).join("\n");
    expect(texts).toContain("카드 제목 40자 넘음");
    expect(texts).toContain("권장 이유 60자 넘음");
  });

  test("서버가 권장 줄을 그리면 detail 의 굵은 글씨는 0개까지", () => {
    const detail = "★ 권장: 가 — 싸다\n\n**중요** 사실입니다.";
    expect(codes(lintAsk({ title: "어느 쪽으로 할까요?", detail, recReason: "싸다", recLabel: "가" }))).toContain("bold");
    expect(codes(lintAsk({ title: "어느 쪽으로 할까요?", detail: "**★ 권장: 가. 싸다.**\n\n사실입니다." }))).not.toContain("bold");
    expect(codes(lintAsk({ title: "어느 쪽으로 할까요?", detail: "**하나** 사실입니다." }))).not.toContain("bold");
  });

  test("선택지와 이유의 용어도 본다", () => {
    const texts = lintAsk({ title: "어떻게 할까요?", detail: "확정: 사실입니다.", options: [{ label: "지금 배포해", desc: "바로 됩니다" }] }).map((w) => w.text).join("\n");
    expect(texts).toContain("'배포' 대신 '대표 화면에 반영'");
  });
});

describe("자료 검사", () => {
  test("제목 길이와 본문 용어, '세부' 장의 코드 무늬는 세지 않는다", () => {
    const content = "# 결론\n웹을 바꿨습니다. 시험으로 확인했습니다.\n\n## ⑤ 세부\n바뀐 파일: server/roles.ts, web/src/App.tsx";
    expect(codes(lintFile({ title: "웹을 바꿨습니다", content }))).not.toContain("codeish");
    expect(codes(lintFile({ title: "웹을 바꿨습니다", content: "바뀐 파일은 server/roles.ts 입니다." }))).toContain("codeish");
    expect(codes(lintFile({ title: "가".repeat(46) }))).toContain("length-title");
    expect(lintFile({ title: "자료 제목" })).toEqual([]);
  });
});

describe("헛경고 줄이기", () => {
  test("제품 이름·'아마존'은 걸리지 않고, 경고 글의 조사는 이름에 맞춘다", () => {
    expect(lintPost({ title: "Next.js 화면 시안을 올렸습니다", body: "아마존 웹서비스 요금표를 확인했습니다." })).toEqual([]);
    expect(codes(lintPost({ title: "iCloud 동기화를 고쳤습니다", body: "watchOS·Node.js 화면도 시험으로 확인했습니다." }))).not.toContain("codeish");
    // 낱말 '아마'는 여전히 흐린 말로 본다.
    expect(codes(lintPost({ title: "로그인 오류 원인", body: "아마 토큰 만료 때문입니다." }))).toContain("hedge");
    const file = lintPost({ title: "웹 화면을 고쳤습니다", body: "server/roles.ts 와 roles.ts 를 고쳤고 시험으로 확인했습니다." }).map((w) => w.text).join("\n");
    expect(file).toContain("파일 이름은 본문에");
    expect(file).not.toContain("이름는");
    const hash = lintPost({ title: "커밋했습니다", body: "커밋 3f9a2c1 을 시험으로 확인했습니다." }).map((w) => w.text).join("\n");
    expect(hash).toContain("커밋 해시는 본문에");
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
