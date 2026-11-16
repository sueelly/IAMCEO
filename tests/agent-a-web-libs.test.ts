// Agent-A 화면의 계산 모듈: 본문 고치기의 서식 단추(web/src/lib/md-format.ts) · 빠른 라벨 목록(web/src/lib/agent-a-labels.ts).
import { describe, expect, test } from "bun:test";
import { DEFAULT_LABELS, MAX_LABELS, THUMBS_UP, cleanLabel, labelOf, labelText, loadLabels, saveLabels } from "../web/src/lib/agent-a-labels.ts";
import { kindLabel } from "../web/src/lib/agent-a-review.ts";
import { applyEdit, codeBlock, heading, link, linePrefix, wrap, type MdEdit } from "../web/src/lib/md-format.ts";

/** 서식을 적용한 본문과, 바꾼 뒤에 고른 글. */
const done = (text: string, edit: MdEdit): [string, string] => {
  const next = applyEdit(text, edit);
  return [next, next.slice(edit.selectFrom, edit.selectTo)];
};
const at = (text: string, needle: string): [number, number] => {
  const i = text.indexOf(needle);
  return [i, i + needle.length];
};

describe("서식 단추", () => {
  test("감싸기: 고른 글을 감싸고, 다시 누르면 벗긴다. 앞뒤 빈칸은 표시 밖에 둔다", () => {
    const text = "가 나다 라";
    const [s, e] = at(text, "나다");
    const bold = wrap(text, s, e, "**");
    expect(done(text, bold)).toEqual(["가 **나다** 라", "나다"]);
    // 감싼 글 안쪽을 고른 채 다시 누르면 벗긴다
    const wrapped = applyEdit(text, bold);
    expect(done(wrapped, wrap(wrapped, bold.selectFrom, bold.selectTo, "**"))).toEqual([text, "나다"]);
    // 표시까지 골랐어도 벗긴다
    const [ws, we] = at(wrapped, "**나다**");
    expect(done(wrapped, wrap(wrapped, ws, we, "**"))).toEqual([text, "나다"]);
    // 앞뒤 빈칸
    const spaced = "가  나다  라";
    expect(done(spaced, wrap(spaced, 1, 7, "*"))).toEqual(["가  *나다*  라", "나다"]);
    // 고른 글이 없으면 표시 한 쌍을 넣고 사이에 커서를 둔다
    const empty = wrap("가나", 1, 1, "~~");
    expect([applyEdit("가나", empty), empty.selectFrom, empty.selectTo]).toEqual(["가~~~~나", 3, 3]);
    expect(done("a b", wrap("a b", 0, 1, "`"))).toEqual(["`a` b", "a"]);
  });

  test("줄 머리: 목록·번호·인용을 붙이고 떼고, 목록끼리는 서로 바꾼다. 빈 줄은 건너뛴다", () => {
    const text = "머리\n첫째\n둘째\n\n셋째\n끝";
    const [s] = at(text, "첫째");
    const e = at(text, "셋째")[1];
    const bullets = applyEdit(text, linePrefix(text, s, e, "bullet"));
    expect(bullets).toBe("머리\n- 첫째\n- 둘째\n\n- 셋째\n끝");
    const be = at(bullets, "셋째")[1];
    const numbers = applyEdit(bullets, linePrefix(bullets, at(bullets, "- 첫째")[0], be, "number"));
    expect(numbers).toBe("머리\n1. 첫째\n2. 둘째\n\n3. 셋째\n끝");
    const ne = at(numbers, "셋째")[1];
    expect(applyEdit(numbers, linePrefix(numbers, at(numbers, "1. 첫째")[0], ne, "number"))).toBe(text);
    const quoted = applyEdit(text, linePrefix(text, s, s, "quote"));
    expect(quoted).toBe("머리\n> 첫째\n둘째\n\n셋째\n끝");
    expect(applyEdit(quoted, linePrefix(quoted, at(quoted, "첫째")[0], at(quoted, "첫째")[1], "quote"))).toBe(text);
    // 들여쓴 목록은 들여쓰기를 지킨다
    expect(applyEdit("  - 안쪽", linePrefix("  - 안쪽", 4, 4, "number"))).toBe("  1. 안쪽");
    // 줄 끝의 줄바꿈까지 골랐어도 다음 줄은 건드리지 않는다
    expect(applyEdit("가\n나", linePrefix("가\n나", 0, 2, "bullet"))).toBe("- 가\n나");
  });

  test("제목: 글 → # → ## → ### → 글 로 돈다. 커서가 있는 줄만 바꾼다", () => {
    let text = "앞\n제목 줄\n뒤";
    const steps: string[] = [];
    for (let i = 0; i < 4; i++) {
      text = applyEdit(text, heading(text, text.indexOf("제목 줄")));
      steps.push(text.split("\n")[1]!);
    }
    expect(steps).toEqual(["# 제목 줄", "## 제목 줄", "### 제목 줄", "제목 줄"]);
    expect(text).toBe("앞\n제목 줄\n뒤");
  });

  test("링크와 코드 블록", () => {
    const text = "여기 글 있음";
    const [s, e] = at(text, "글");
    expect(done(text, link(text, s, e))).toEqual(["여기 [글](주소) 있음", "주소"]);
    expect(done("https://example.com", link("https://example.com", 0, 19))).toEqual(["[](https://example.com)", ""]);
    expect(done("가", link("가", 1, 1))).toEqual(["가[글](주소)", "글"]);
    const code = "앞\nconst a = 1;\n뒤";
    const [cs, ce] = at(code, "const a = 1;");
    expect(done(code, codeBlock(code, cs, ce))).toEqual(["앞\n```\nconst a = 1;\n```\n뒤", "const a = 1;"]);
    // 본문에 ``` 가 들어 있으면 더 긴 울타리를 쓴다
    const fenced = "```\n안쪽\n```";
    expect(applyEdit(fenced, codeBlock(fenced, 0, fenced.length))).toBe("````\n```\n안쪽\n```\n````");
    const empty = codeBlock("가", 1, 1);
    expect([applyEdit("가", empty), empty.selectFrom]).toEqual(["가\n```\n\n```\n", 6]);
  });
});

describe("빠른 라벨 목록", () => {
  const storage = (initial?: string) => {
    const data = new Map<string, string>(initial === undefined ? [] : [["iamceo.agentA.labels", initial]]);
    return () => ({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) }) as unknown as Storage;
  };

  test("기본 라벨은 열 개이고, 라벨 글은 '이모지 이름' 한 줄이다", () => {
    expect(DEFAULT_LABELS).toHaveLength(10);
    expect(new Set(DEFAULT_LABELS.map((l) => l.id)).size).toBe(10);
    expect(labelText(THUMBS_UP)).toBe("👍 좋아요");
    expect(labelText({ emoji: "", text: "이모지 없음" })).toBe("이모지 없음");
    for (const l of DEFAULT_LABELS) expect(/[\r\n]/.test(labelText(l)) || labelText(l).length > 200).toBe(false);
    expect(labelOf("🔍 확인이 필요해요", DEFAULT_LABELS)?.id).toBe("verify-this");
    expect(labelOf("👍 좋아요", [])?.id).toBe("thumbs-up");
    expect(labelOf("모르는 라벨", DEFAULT_LABELS)).toBeNull();
    expect(kindLabel({ kind: "comment", region: null, label: true })).toBe("라벨");
    expect(kindLabel({ kind: "comment", region: null })).toBe("문장");
  });

  test("고친 라벨을 기억하고, 틀린 것은 버리고, 비면 기본 라벨로 돌아간다", () => {
    const store = storage();
    expect(loadLabels(store)).toBe(DEFAULT_LABELS);
    saveLabels([{ id: "mine", emoji: "🏷️", text: "  내  라벨 ", tone: "pink", tip: " 지침 " }], store);
    expect(loadLabels(store)).toEqual([{ id: "mine", emoji: "🏷️", text: "내 라벨", tone: "pink", tip: "지침" }]);
    saveLabels(null, store);
    expect(loadLabels(store)).toBe(DEFAULT_LABELS);
    expect(cleanLabel({ id: "x", emoji: "", text: "", tone: "pink" })).toBeNull();
    expect(cleanLabel({ id: "나쁜 id", emoji: "", text: "글", tone: "pink" })).toBeNull();
    expect(cleanLabel({ id: "ok", emoji: "✅", text: "글", tone: "없는색" })).toEqual({ id: "ok", emoji: "✅", text: "글", tone: "yellow" });
    // 깨진 저장 값·같은 id·너무 많은 라벨
    expect(loadLabels(storage("{깨짐"))).toBe(DEFAULT_LABELS);
    expect(loadLabels(storage(JSON.stringify([{ id: "a", text: "하나", emoji: "", tone: "blue" }, { id: "a", text: "둘", emoji: "", tone: "blue" }, 3])))).toEqual([{ id: "a", emoji: "", text: "하나", tone: "blue" }]);
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `l${i}`, emoji: "", text: `라벨 ${i}`, tone: "blue" }));
    expect(loadLabels(storage(JSON.stringify(many)))).toHaveLength(MAX_LABELS);
    expect(loadLabels(storage("[]"))).toBe(DEFAULT_LABELS);
  });
});
