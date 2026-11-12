// 대화 카드에서 보낸 답의 결과를 잠시 들고 있는다. 답하면 직원이 막힘에서 풀려 카드가 사라지므로, 결과 줄을 이만큼 더 보인다.
import { useSyncExternalStore } from "react";
import type { NativeAnswerReceipt } from "@shared/types";

/** 결과 줄을 보이는 시간 */
export const RESULT_SHOW_MS = 120_000;
let entries: ReadonlyMap<string, NativeAnswerReceipt> = new Map();
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export function noteAnswer(memberId: string, receipt: NativeAnswerReceipt): void {
  const next = new Map(entries);
  next.set(memberId, receipt);
  entries = next;
  emit();
  setTimeout(() => { if (entries.get(memberId) === receipt) dismissAnswer(memberId); }, RESULT_SHOW_MS);
}
export function dismissAnswer(memberId: string): void {
  if (!entries.has(memberId)) return;
  const next = new Map(entries);
  next.delete(memberId);
  entries = next;
  emit();
}
export function lastAnswer(memberId: string): NativeAnswerReceipt | null {
  return entries.get(memberId) ?? null;
}
export function useRecentAnswers(): ReadonlyMap<string, NativeAnswerReceipt> {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => entries, () => entries);
}
