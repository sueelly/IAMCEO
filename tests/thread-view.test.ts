// 웹 대화·결재 카드가 글을 어떻게 보일지(대표 차례 띠, 결재 카드 사본 한 줄, 총괄 과정 글 접기, 권장 띠, 상태 색 표).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision, MemberKind, Message } from "../shared/types";
import { buildOwnerLine, buildRecLine } from "../shared/owner-lines";
import { cardCopyText, foldLabel, foldPreview, foldThread, isCardCopy, processKind, splitOwnerAction, splitOwnerLine, type KindOf } from "../web/src/lib/thread-view";
import { splitDetail } from "../web/src/lib/decision-view";
import { KIND_TONE, STATUS_TONES, kindTone } from "../web/src/lib/tone";

const msg = (id: string, at: string, over: Partial<Message> = {}): Message => ({
  id, projectId: "p", at, mine: false, memberId: null, who: "", kind: "진행", title: "", body: "",
  targetMemberId: null, targetName: null, decisionId: null, fileId: null, attachments: [], delivery: null, deliveryNote: null, ...over,
});

const decision = (over: Partial<Decision> = {}): Decision => ({
  id: "d1", projectId: "p", memberId: "lead", who: "총괄", title: "커밋할까요?", detail: "", options: [], rec: null, group: null, fileId: null, images: [],
  status: "open", choice: null, note: null, batch: false, createdAt: "2026-11-09T02:28:05Z", answeredAt: null, deliveredAt: null, updatedAt: "2026-11-09T02:28:05Z",
  lastChoice: null, lastNote: null, reopenNote: null, closeKind: null, closeReason: null, closeQuote: null, closedBy: null, closedAt: null, ...over,
});

const KINDS: Record<string, MemberKind> = { lead: "conductor", web: "worker", native: "worker", hq: "root" };
const kindOf: KindOf = (id) => (id ? KINDS[id] : undefined);

const owner = (id: string, at: string) => msg(id, at, { mine: true, kind: "나", who: "나", body: "웹·네이티브에 시안을 적용해" });
const lead = (id: string, at: string, over: Partial<Message> = {}) => msg(id, at, { memberId: "lead", who: "디자인 개편 총괄", ...over });
const web = (id: string, at: string, over: Partial<Message> = {}) => msg(id, at, { memberId: "web", who: "웹 화면 구현", ...over });
const native = (id: string, at: string, over: Partial<Message> = {}) => msg(id, at, { memberId: "native", who: "네이티브 앱 구현", ...over });

/** 11월 9일 디자인 개편 대화(제목만 줄임). */
const nov9 = (): Message[] => [
  owner("o1", "2026-11-09T01:15:29.306Z"),
  lead("assign", "2026-11-09T01:16:13.256Z", { title: "웹·네이티브 앱 적용 맡겼습니다", body: "알겠습니다. 직원 둘을 새로 띄워 동시에 진행합니다." }),
  web("w1", "2026-11-09T01:20:58.367Z", { title: "라이트 글라스 웹 적용 시작" }),
  native("n1", "2026-11-09T01:27:55.664Z", { title: "네이티브 앱 라이트 글라스 적용 시작" }),
  web("w2", "2026-11-09T01:37:05.138Z", { title: "색 바꾸기는 끝났고 시험을 기다립니다" }),
  native("n2", "2026-11-09T01:55:50.298Z", { title: "코드 변환 끝, 앱 만들기 확인 중" }),
  web("w3", "2026-11-09T02:24:21.319Z", { kind: "완료", title: "웹 전 화면을 라이트 글라스로 바꿨습니다", fileId: "f_web" }),
  lead("re1", "2026-11-09T02:24:30.958Z", { kind: "알림", title: "웹 적용 끝, 네이티브는 확인 중" }),
  lead("re2", "2026-11-09T02:24:43.698Z", { title: "웹 완료, 네이티브는 작업 중(보고 대기)", fileId: "f_web" }),
  native("n3", "2026-11-09T02:27:50.800Z", { kind: "완료", title: "맥·아이폰 앱 적용", fileId: "f_mac" }),
  lead("ask", "2026-11-09T02:28:05.748Z", { kind: "질문", title: "웹·네이티브 라이트 테마 변경을 커밋할까요?", body: "**상태**\n- 웹: 23개 파일", decisionId: "d1", fileId: "f_mac" }),
];

describe("총괄 과정 글 접기", () => {
  test("11월 9일 대화: 맡김 1건과 다시 알림 2건이 접히고, 글 3개가 접은 줄 2개가 된다(11줄에서 10줄)", () => {
    const items = foldThread(nov9(), kindOf);
    expect(items.length).toBe(10);
    const folds = items.filter((i) => i.type === "fold");
    expect(folds.map((f) => (f.type === "fold" ? [f.messages.map((m) => m.id), foldLabel(f)] : null))).toEqual([
      [["assign"], "총괄 · 맡김 1건"],
      [["re1", "re2"], "총괄 · 다시 알림 2건"],
    ]);
    // 직원 보고·결재 카드 사본·대표 말은 접지 않는다.
    for (const id of ["o1", "w1", "n1", "w3", "n3", "ask"]) expect(items.some((i) => i.type === "message" && i.message.id === id)).toBe(true);
  });

  test("맡김: 대표 말 바로 뒤라도 맡겼다는 말이 없으면 접지 않는다(말만으로도 접지 않는다)", () => {
    const list = [owner("o", "2026-11-09T01:00:00Z"), lead("l", "2026-11-09T01:00:30Z", { title: "현재 상황을 정리했습니다" })];
    expect(processKind(list, 1, kindOf)).toBeNull();
    // 말은 있어도 대표 말 뒤가 아니면(직원 보고 뒤 2분 밖) 아니다.
    const late = [web("w", "2026-11-09T01:00:00Z"), lead("l", "2026-11-09T01:05:00Z", { title: "민수에게 맡겼습니다" })];
    expect(processKind(late, 1, kindOf)).toBeNull();
    // 대표 말 뒤 10분이 넘으면 아니다.
    const slow = [owner("o", "2026-11-09T01:00:00Z"), lead("l", "2026-11-09T01:11:00Z", { title: "민수에게 맡겼습니다" })];
    expect(processKind(slow, 1, kindOf)).toBeNull();
    // 시스템 글은 사이에 있어도 된다.
    const sys = [owner("o", "2026-11-09T01:00:00Z"), msg("s", "2026-11-09T01:00:10Z", { kind: "시스템", who: "시스템" }), lead("l", "2026-11-09T01:00:40Z", { title: "민수에게 맡겼습니다" })];
    expect(processKind(sys, 2, kindOf)).toBe("assign");
  });

  test("다시 알림: 직원 보고 뒤 2분 안의 총괄 진행·알림만 접는다", () => {
    const base = web("w", "2026-11-09T02:00:00Z", { kind: "완료", fileId: "f1" });
    expect(processKind([base, lead("l", "2026-11-09T02:01:59Z", { kind: "알림" })], 1, kindOf)).toBe("renotify");
    expect(processKind([base, lead("l", "2026-11-09T02:02:01Z", { kind: "알림" })], 1, kindOf)).toBeNull();
    // 사이에 대표 말이 있으면 대표에게 하는 답이다.
    expect(processKind([base, owner("o", "2026-11-09T02:00:30Z"), lead("l", "2026-11-09T02:01:00Z")], 2, kindOf)).toBeNull();
    // 다른 자료를 이으면 새 내용이다.
    expect(processKind([base, lead("l", "2026-11-09T02:00:30Z", { fileId: "f2" })], 1, kindOf)).toBeNull();
    expect(processKind([base, lead("l", "2026-11-09T02:00:30Z", { fileId: "f1" })], 1, kindOf)).toBe("renotify");
  });

  test("대표 차례 줄·결재·첨부·완료·막힘·답변이 있는 총괄 글, 직원 글, 본사 AI 글은 접지 않는다", () => {
    const w = web("w", "2026-11-09T02:00:00Z", { kind: "완료" });
    const at = "2026-11-09T02:00:20Z";
    const cases: Message[] = [
      lead("a", at, { body: `${buildOwnerLine("커밋할지 정해 주세요 · 결재함 1건")}\n\n웹은 끝났습니다.` }),
      lead("b", at, { decisionId: "d1" }),
      lead("c", at, { attachments: [{ id: "x", name: "a.png", mime: "image/png", size: 1, url: "/x", path: "/x", isImage: true }] }),
      lead("d", at, { kind: "완료" }),
      lead("e", at, { kind: "막힘" }),
      lead("f", at, { kind: "답변" }),
      native("g", at, { kind: "알림" }),
      msg("h", at, { memberId: "hq", kind: "알림" }),
    ];
    for (const m of cases) expect([m.id, processKind([w, m], 1, kindOf)]).toEqual([m.id, null]);
  });

  test("총괄 보고 뒤의 총괄 글은 직원 보고가 아니라 접지 않는다. 앞 글을 모르면(목록 맨 앞) 접지 않는다", () => {
    expect(processKind([lead("x", "2026-11-09T02:00:00Z", { kind: "완료" }), lead("l", "2026-11-09T02:00:20Z", { kind: "알림" })], 1, kindOf)).toBeNull();
    expect(processKind([lead("l", "2026-11-09T02:00:20Z", { kind: "알림" })], 0, kindOf)).toBeNull();
  });

  test("떨어진 과정 글은 따로 접고, 접은 줄 id 는 첫 글에서 나와 글이 늘어도 같다", () => {
    const list = nov9();
    const before = foldThread(list, kindOf).filter((i) => i.type === "fold").map((i) => i.type === "fold" && i.id);
    const more = [...list, msg("late", "2026-11-09T03:00:00Z", { memberId: "web", kind: "진행" })];
    const after = foldThread(more, kindOf).filter((i) => i.type === "fold").map((i) => i.type === "fold" && i.id);
    expect(after).toEqual(before);
    expect(before).toEqual(["fold:assign", "fold:re1"]);
  });

  test("새 소식(실패·앞 보고와 다름·원인)이 있는 총괄 글은 접지 않는다", () => {
    const done = web("w", "2026-11-09T02:00:00Z", { kind: "완료", title: "로그인 고침" });
    const differs = lead("l", "2026-11-09T02:00:30Z", { kind: "알림", title: "민수 보고와 달리 시험 2개가 실패합니다. 다시 맡겼습니다" });
    expect(processKind([done, differs], 1, kindOf)).toBeNull();
    const still = lead("l2", "2026-11-09T02:00:30Z", { kind: "알림", title: "웹은 끝, 네이티브는 아직 앱 만들기에서 막혔습니다" });
    expect(processKind([done, still], 1, kindOf)).toBeNull();
    // 같은 2분 안이라도 본문이 길면(3줄 이상) 새 소식이 있을 수 있어 그대로 둔다.
    const long = lead("l3", "2026-11-09T02:00:30Z", { kind: "알림", title: "정리", body: "웹: 끝\n맥: 시험 중\n아이폰: 서명 기다림" });
    expect(processKind([done, long], 1, kindOf)).toBeNull();
    // 같은 자료를 잇는 글은 되풀이다.
    expect(processKind([{ ...done, fileId: "f1" }, { ...long, fileId: "f1" }], 1, kindOf)).toBe("renotify");
  });

  test("맡김: 대표의 물음에 답한 글은 맡겼다는 말이 있어도 접지 않는다", () => {
    const ask = msg("o", "2026-11-09T01:00:00Z", { mine: true, kind: "나", who: "나", body: "로그인이 왜 안 돼?" });
    const reply = lead("l", "2026-11-09T01:00:30Z", { title: "원인은 토큰 만료입니다. 수정은 민수에게 맡겼습니다" });
    expect(processKind([ask, reply], 1, kindOf)).toBeNull();
    const plain = lead("l2", "2026-11-09T01:00:30Z", { title: "수정은 민수에게 맡겼습니다" });
    expect(processKind([ask, plain], 1, kindOf)).toBeNull();
    expect(processKind([owner("o2", "2026-11-09T01:00:00Z"), plain], 1, kindOf)).toBe("assign");
  });

  test("접은 줄에는 첫 글의 제목이 함께 보인다", () => {
    const fold = foldThread(nov9(), kindOf).find((i) => i.type === "fold");
    expect(fold && fold.type === "fold" && foldPreview(fold)).toBe("웹·네이티브 앱 적용 맡겼습니다");
    expect(foldPreview({ messages: [lead("x", "2026-11-09T01:00:00Z", { title: "", body: "\n  첫 줄\n둘째 줄" })] })).toBe("첫 줄");
  });

  test("명부에서 빠진 직원의 보고 뒤 총괄 글도 다시 알림으로 접는다", () => {
    const gone = msg("g", "2026-11-09T02:00:00Z", { memberId: "removed", kind: "완료" });
    expect(processKind([gone, lead("l", "2026-11-09T02:00:30Z", { kind: "알림" })], 1, kindOf)).toBe("renotify");
  });
});

describe("대표 차례 띠", () => {
  test("본문 첫 줄을 띠로 떼고 나머지만 본문에 남긴다", () => {
    const body = `${buildOwnerLine("커밋할지 정해 주세요 · 결재함 1건")}\n\n지금 단계: 바꾸고 시험으로 확인했습니다.`;
    expect(splitOwnerLine(body)).toEqual({ action: "커밋할지 정해 주세요 · 결재함 1건", rest: "지금 단계: 바꾸고 시험으로 확인했습니다." });
    expect(splitOwnerLine("그냥 보고")).toEqual({ action: null, rest: "그냥 보고" });
    // 첫 줄이 아니면 띠가 아니다.
    expect(splitOwnerLine(`지금 단계: 끝\n${buildOwnerLine("보세요")}`).action).toBeNull();
  });

  test("글 끝의 '결재함 N건'은 오른쪽 링크로 뗀다", () => {
    expect(splitOwnerAction("커밋할지 정해 주세요 · 결재함 1건")).toEqual({ text: "커밋할지 정해 주세요", inbox: "결재함 1건" });
    expect(splitOwnerAction("커밋할지 정해 주세요(결재함 1건).")).toEqual({ text: "커밋할지 정해 주세요", inbox: "결재함 1건" });
    expect(splitOwnerAction("시안을 보고 고르세요 (결재함 2 건)")).toEqual({ text: "시안을 보고 고르세요", inbox: "결재함 2건" });
    expect(splitOwnerAction("결재함 1건에서 골라 주세요")).toEqual({ text: "결재함 1건에서 골라 주세요", inbox: null });
    expect(splitOwnerAction("결재함 1건")).toEqual({ text: "결재함 1건", inbox: null });
  });
});

describe("결재 카드 사본 한 줄", () => {
  const opts = [{ k: "both", label: "지금 둘 다 메인에 커밋" }, { k: "web", label: "웹만 먼저 커밋" }];
  const m = msg("ask", "2026-11-09T02:28:05Z", { memberId: "lead", kind: "질문", title: "웹·네이티브 변경을 커밋할까요?", decisionId: "d1" });

  test("질문 + 결재 id 만 사본이다", () => {
    expect(isCardCopy(m)).toBe(true);
    expect(isCardCopy({ ...m, decisionId: null })).toBe(false);
    expect(isCardCopy({ ...m, kind: "완료" })).toBe(false);
  });

  test("열린 카드는 권장, 답한 카드는 답, 닫힌 카드는 닫힘을 한 줄에 쓴다", () => {
    const d = decision({ title: "웹·네이티브 변경을 커밋할까요?", options: opts, rec: "web" });
    expect(cardCopyText(m, d)).toBe("결재 1건: 웹·네이티브 변경을 커밋할까요? · 권장 웹만 먼저 커밋 → 결재함");
    expect(cardCopyText(m, { ...d, rec: null })).toBe("결재 1건: 웹·네이티브 변경을 커밋할까요? → 결재함");
    expect(cardCopyText(m, { ...d, status: "delivered", choice: "both" })).toBe("결재 1건: 웹·네이티브 변경을 커밋할까요? · 답함 지금 둘 다 메인에 커밋 → 결재함");
    expect(cardCopyText(m, { ...d, status: "answered", choice: null, note: "내일 다시" })).toBe("결재 1건: 웹·네이티브 변경을 커밋할까요? · 답함 내일 다시 → 결재함");
    expect(cardCopyText(m, { ...d, status: "closed" })).toBe("결재 1건: 웹·네이티브 변경을 커밋할까요? · 닫힘 → 결재함");
    // 카드를 아직 못 받았으면 글 제목으로.
    expect(cardCopyText(m, undefined)).toBe("결재 1건: 웹·네이티브 변경을 커밋할까요? → 결재함");
  });
});

describe("결재 카드 권장 띠", () => {
  const options = [
    { k: "apikey", label: "유료 API 키로 해" },
    { k: "agy", label: "Antigravity를 조사해" },
    { k: "cloud", label: "Google Cloud 키로 해" },
    { k: "hold", label: "Gemini는 보류해" },
  ];
  test("첫 줄 권장 줄을 띠로 떼고, 나머지 글(표 등)만 선택지 아래에 둔다", () => {
    const detail = `${buildRecLine("유료 API 키로 해", "공식 안내로 지금 되는 방법입니다. 감수할 것: 쓴 만큼 요금이 나옵니다")}\n\n| 방법 | 지금 되나 |\n|---|---|\n| 유료 API 키 | 됨 |`;
    const { rec, rest } = splitDetail({ detail, options, rec: "apikey" });
    expect(rec).toEqual({ label: "유료 API 키로 해", reason: "공식 안내로 지금 되는 방법입니다. 감수할 것: 쓴 만큼 요금이 나옵니다", plain: false });
    expect(rest.startsWith("| 방법 |")).toBe(true);
    expect(rest).not.toContain("★");
  });
  test("권장 줄이 없으면 글 전체를 그대로 둔다", () => {
    expect(splitDetail({ detail: "지금 브랜드 색은 **보라**입니다.", options, rec: "apikey" })).toEqual({ rec: null, rest: "지금 브랜드 색은 **보라**입니다." });
    expect(splitDetail({ detail: "", options: [], rec: null })).toEqual({ rec: null, rest: "" });
  });
  test("직원이 손으로 쓴, 안과 이유가 갈리지 않는 줄은 굵게 하지 않는다", () => {
    const { rec } = splitDetail({ detail: "**★ 권장: 유료 API 키.** 공식 안내로 지금 되는 방법입니다.\n\n표", options, rec: "apikey" });
    expect(rec?.plain).toBe(true);
  });
});

describe("상태 색 표", () => {
  test("상태 색은 셋(초록 완료·빨강 막힘·주황 대표 차례)이고 보라는 쓰지 않는다", () => {
    expect(STATUS_TONES.length).toBeLessThanOrEqual(3);
    expect(kindTone("완료")).toBe("ok");
    expect(kindTone("막힘")).toBe("danger");
    expect(kindTone("질문")).toBe("warn");
    for (const k of ["진행", "알림", "답변"] as const) expect(kindTone(k)).toBe("plain");
    const used = new Set(Object.values(KIND_TONE));
    expect(used.has("accent")).toBe(false);
    for (const t of used) expect(t === "plain" || STATUS_TONES.includes(t)).toBe(true);
  });
  test("대화·홈은 따로 색 표를 두지 않고 같은 표를 쓴다", () => {
    for (const file of ["web/src/screens/Thread.tsx", "web/src/screens/Home.tsx"]) {
      const src = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(src).not.toMatch(/KIND_TONE\s*[:=]/);
      expect(src).toContain("kindTone(");
    }
  });
});
