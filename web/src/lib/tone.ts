// 상태 색 표 하나. 화면마다 따로 정하지 않는다(대화·홈이 같은 표를 쓴다).
// 상태 색은 셋만 쓴다: 초록 완료 · 빨강 막힘 · 주황 대표 차례(대표가 할 일). 보라는 '권장'에만 쓴다.
// 진행·알림처럼 대표가 할 일이 없는 글은 색 없이 회색 글자로 둔다.
import type { MessageKind } from "@shared/types";

/** neutral 옅은 칩 · plain 바닥 없는 회색 글자 · accent 보라(권장 전용) · ok 초록 · warn 주황 · danger 빨강 */
export type BadgeTone = "neutral" | "plain" | "accent" | "ok" | "warn" | "danger";

/** 보고 종류의 색. 질문은 대표가 답할 차례라 주황이다. */
export const KIND_TONE: Readonly<Record<MessageKind, BadgeTone>> = {
  완료: "ok",
  막힘: "danger",
  질문: "warn",
  진행: "plain",
  알림: "plain",
  답변: "plain",
  지시: "plain",
  직접: "plain",
  나: "plain",
  시스템: "plain",
};

export const kindTone = (kind: MessageKind): BadgeTone => KIND_TONE[kind] ?? "plain";

/** 상태 색으로 쓰는 값. 시험이 이 수(3)를 넘지 않는지 본다. */
export const STATUS_TONES: readonly BadgeTone[] = ["ok", "warn", "danger"];
