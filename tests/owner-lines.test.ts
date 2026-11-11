import { describe, expect, test } from "bun:test";
import { buildOwnerLine, buildRecLine, parseOwnerLine, parseRecLine, withOwnerLine, withRecLine } from "../shared/owner-lines.ts";

describe("대표 차례 줄", () => {
  test("서버가 쓰는 줄 모양은 정확히 '● 대표 차례: <할 일>'이다", () => {
    expect(buildOwnerLine("커밋할지 정해 주세요 · 결재함 1건")).toBe("● 대표 차례: 커밋할지 정해 주세요 · 결재함 1건");
    expect(buildOwnerLine("  줄을\n 바꿔도   한 줄 ")).toBe("● 대표 차례: 줄을 바꿔도 한 줄");
  });

  test("본문 맨 위에 붙이고, 빈 할 일이면 본문을 그대로 둔다", () => {
    expect(withOwnerLine("결과입니다.", "정해 주세요")).toBe("● 대표 차례: 정해 주세요\n\n결과입니다.");
    expect(withOwnerLine("", "정해 주세요")).toBe("● 대표 차례: 정해 주세요");
    expect(withOwnerLine(undefined, "정해 주세요")).toBe("● 대표 차례: 정해 주세요");
    expect(withOwnerLine("결과입니다.", "")).toBe("결과입니다.");
    expect(withOwnerLine("결과입니다.", "   ")).toBe("결과입니다.");
    expect(withOwnerLine(undefined, undefined)).toBe("");
  });

  test("이미 대표 차례 줄로 시작하면 두 줄이 되지 않게 바꾼다", () => {
    const body = "● 대표 차례: 예전 할 일\n\n결과입니다.";
    expect(withOwnerLine(body, "새 할 일")).toBe("● 대표 차례: 새 할 일\n\n결과입니다.");
  });

  test("읽기: 첫 줄만 보고, 손으로 쓴 굵은 줄·전각 쌍점도 읽는다", () => {
    expect(parseOwnerLine("● 대표 차례: 정해 주세요\n\n결과\n둘째 줄")).toEqual({ action: "정해 주세요", rest: "결과\n둘째 줄" });
    expect(parseOwnerLine("\n\n**● 대표 차례:** 골라 주세요\n본문")).toEqual({ action: "골라 주세요", rest: "본문" });
    expect(parseOwnerLine("●대표 차례：확인해 주세요")).toEqual({ action: "확인해 주세요", rest: "" });
    expect(parseOwnerLine("결과\n● 대표 차례: 둘째 줄은 아니다")).toBeNull();
    expect(parseOwnerLine("● 대표 차례:")).toBeNull();
    expect(parseOwnerLine("")).toBeNull();
    expect(parseOwnerLine(null)).toBeNull();
  });

  test("쓴 것을 그대로 읽는다", () => {
    const body = withOwnerLine("| 안 | 일정 |\n|---|---|\n| A | 3일 |", "범위를 골라 주세요 · 결재함 1건");
    expect(parseOwnerLine(body)).toEqual({ action: "범위를 골라 주세요 · 결재함 1건", rest: "| 안 | 일정 |\n|---|---|\n| A | 3일 |" });
  });
});

describe("권장 줄", () => {
  test("서버가 쓰는 줄 모양은 정확히 '★ 권장: <label> — <이유>'이다", () => {
    expect(buildRecLine("유료 API 키로 해", "구독 안에서는 붙일 길이 없습니다")).toBe("★ 권장: 유료 API 키로 해 — 구독 안에서는 붙일 길이 없습니다");
    expect(buildRecLine("가", "")).toBe("★ 권장: 가");
  });

  test("detail 맨 위에 붙이고, 이유나 이름이 비면 그대로 둔다", () => {
    expect(withRecLine("확정: 사실 하나.", "가", "싸다")).toBe("★ 권장: 가 — 싸다\n\n확정: 사실 하나.");
    expect(withRecLine("", "가", "싸다")).toBe("★ 권장: 가 — 싸다");
    expect(withRecLine("배경", "가", "")).toBe("배경");
    expect(withRecLine("배경", undefined, "싸다")).toBe("배경");
  });

  test("이미 권장 줄로 시작하면 바꾼다", () => {
    expect(withRecLine("**★ 권장: 나. 이유. 감수할 것: 느림**\n\n배경", "가", "싸다")).toBe("★ 권장: 가 — 싸다\n\n배경");
  });

  test("읽기: 이름과 이유를 가르고, 손으로 쓴 줄은 통째로 이름이 된다", () => {
    expect(parseRecLine("★ 권장: 유료 API 키로 해 — 구독 안에는 길이 없습니다\n\n| 안 | 비용 |")).toEqual({
      text: "유료 API 키로 해 — 구독 안에는 길이 없습니다", label: "유료 API 키로 해", reason: "구독 안에는 길이 없습니다", rest: "| 안 | 비용 |",
    });
    expect(parseRecLine("**★ 권장: B. 웹까지 고칩니다. 감수할 것: 8일**\n배경")).toEqual({ text: "B. 웹까지 고칩니다. 감수할 것: 8일", label: "B. 웹까지 고칩니다. 감수할 것: 8일", reason: "", rest: "배경" });
    expect(parseRecLine("배경\n★ 권장: 가 — 이유")).toBeNull();
    expect(parseRecLine(undefined)).toBeNull();
  });

  test("이름 안에 가르는 글자가 있어도 카드의 권장 label 을 주면 바르게 나눈다", () => {
    const detail = withRecLine("배경", "A — 빠른 안", "이틀이면 됩니다");
    expect(parseRecLine(detail, "A — 빠른 안")).toMatchObject({ label: "A — 빠른 안", reason: "이틀이면 됩니다", rest: "배경" });
    expect(parseRecLine(detail)).toMatchObject({ label: "A", reason: "빠른 안 — 이틀이면 됩니다" });
    expect(parseRecLine("★ 권장: 가", "가")).toMatchObject({ label: "가", reason: "" });
  });
});
