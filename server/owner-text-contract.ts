import { contractSchema } from "./contract-schema.ts";
import type { ContractInput, ContractKind } from "./harness.ts";

// Copy terms only from explicitly labelled owner text. If anything is ambiguous,
// the coordinator receives the original, including the lines we could not classify.
const labels = new Map(Object.entries({
  "종류":"kind", "작업 유형":"kind", "업무 유형":"kind", "목표":"goal", "입력":"inputs",
  "출력":"outputs", "산출물":"outputs", "범위":"scope", "제한조건":"constraints", "제약 조건":"constraints",
  "완료 조건":"acceptance", "합격 기준":"acceptance", "제외 범위":"exclusions",
}));
const kinds = new Map<string, ContractKind>([["구현","coding"],["코딩","coding"],["개발","coding"],["조사","research"],["기타","other"]]);
export function readOwnerContract(text: string): ContractInput | undefined {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const raw of text.trim().split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = /^([^:：]+)[:：](.*)$/u.exec(line);
    if (header && !/^[-*]\s/.test(line)) {
      const key = labels.get(header[1]!.trim());
      if (!key || sections.has(key)) return;
      current = []; sections.set(key, current);
      if (header[2]!.trim()) current.push(header[2]!.trim());
    } else {
      const item = /^[-*]\s+(.+)$/u.exec(line);
      if (!current || !item?.[1]?.trim()) return;
      current.push(item[1].trim());
    }
  }
  const one = (key: string) => sections.get(key)?.length === 1 ? sections.get(key)![0] : undefined;
  const kind = kinds.get(one("kind") ?? ""), goal = one("goal"), scope = one("scope");
  const inputs = sections.get("inputs"), outputs = sections.get("outputs"), acceptance = sections.get("acceptance");
  const limits = (key: string) => one(key) === "없음" ? [] : sections.get(key)?.length ? sections.get(key) : undefined;
  const constraints = limits("constraints"), exclusions = limits("exclusions");
  if (!kind || !goal || !scope || !inputs?.length || !outputs?.length || !acceptance?.length || !constraints || !exclusions) return;
  const parsed = contractSchema.safeParse({ kind, goal, scope, inputs, outputs, acceptance, constraints, exclusions });
  return parsed.success ? parsed.data : undefined;
}
