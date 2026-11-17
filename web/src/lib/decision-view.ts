// 결재 카드가 글을 어떻게 보일지 정한다. 화면 없이 시험할 수 있게 React 를 쓰지 않는다.
// detail 첫 줄의 권장 줄은 제목 아래 띠로 빼고, 배경과 근거는 선택지 앞에 둔다.
import type { Decision } from "@shared/types";
import { EXTERNAL_REVIEW_BOILERPLATE, parseRecLine } from "@shared/owner-lines";

/** label 권장 안 · reason 이유(없으면 빈 글) · plain 안과 이유가 갈리지 않은 손글 줄이라 굵게 하지 않는다. */
export type RecBandText = { label: string; reason: string; plain: boolean };

/** 결재 글을 권장 줄과 나머지로 가른다. 권장 줄이 없으면 글 전체가 나머지다. 줄 모양은 shared/owner-lines.ts 가 정한다. */
export function splitDetail(decision: Pick<Decision, "detail" | "options" | "rec">): { rec: RecBandText | null; rest: string } {
  const known = decision.options.find((o) => o.k === decision.rec)?.label ?? null;
  const parsed = parseRecLine(decision.detail, known);
  if (!parsed) return { rec: null, rest: decision.detail };
  const plain = !parsed.reason && parsed.label !== known;
  return { rec: { label: parsed.label, reason: parsed.reason, plain }, rest: parsed.rest };
}

export function decisionDetail(detail: string): string {
  if (!detail.startsWith(EXTERNAL_REVIEW_BOILERPLATE)) return detail;
  const rest = detail.slice(EXTERNAL_REVIEW_BOILERPLATE.length);
  return rest === "" || /^\r?\n(?:\r?\n|$)/.test(rest)
    ? "별도로 진행한 검수 결과를 바탕으로 올린 결재입니다." + rest
    : detail;
}

/** 상세 근거는 원문으로 제공하고, 요약에는 결과와 중요한 미확인을 먼저 보여 준다. */
export const COMPLETION_PREVIEW_LIMIT = 5;
export function noticePreview(lines: readonly string[]): string[] {
  const priority = ["미검증:", "완료 보고:", "대표 화면 반영:", "메인 합침:", "요청한 결과:"];
  const rank = (line: string) => {
    const index = priority.findIndex(prefix => line.startsWith(prefix));
    return index < 0 ? priority.length : index;
  };
  return [...lines]
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, COMPLETION_PREVIEW_LIMIT)
    .map(line => line.replace(/ · \d{4}-\d{2}-\d{2}(?:T\S+)?(?: · 보고 메시지 ID \S+)?$/, ""));
}
