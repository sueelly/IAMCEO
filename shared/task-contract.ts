export type ContractKind = "coding" | "research" | "other";
export const CHECK_KINDS = ["behavior", "typecheck", "regression", "real", "source", "fact", "unverified", "other"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export interface ContractInput {
  kind: ContractKind;
  main_authority?: string;
  goal: string;
  acceptance: string[];
  scope?: string | null;
  /** 누락은 미정이다. 빈 constraints/exclusions 배열은 명시적으로 해당 없음이다. */
  inputs?: string[] | null;
  outputs?: string[] | null;
  constraints?: string[] | null;
  exclusions?: string[] | null;
  forbidden?: string[];
  evidence?: string[];
  /** 비우면 종류별 기본 필수 검사. 빈 배열을 주면 필수 검사 없이 합격 기준만 본다. */
  checks?: CheckKind[];
}
