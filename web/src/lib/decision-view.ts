// 결재 카드가 글을 어떻게 보일지 정한다. 화면 없이 시험할 수 있게 React 를 쓰지 않는다.
// detail 첫 줄의 권장 줄은 제목 아래 띠로 빼고, 나머지 글(표·배경)은 선택지 아래에 둔다.
import type { Decision } from "@shared/types";
import { parseRecLine } from "@shared/owner-lines";

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
