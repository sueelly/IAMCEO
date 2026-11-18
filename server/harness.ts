// 업무 시작 계약과 완료 판정. 계약은 업무에 붙고(직원이 아니다), 판(rev)이 올라가며 바뀐다.
// 완료 판정은 보고에 적은 검사로 한다. 실행 검사(behavior·typecheck·regression)의 통과는 harness-evidence 가 제공자 실행 기록과 대조한다.
// 그 밖의 종류(real·source·fact·other)는 작성자 보고다. 조사의 사실 주장은 claims 로 원문과 대조한다.

export type ContractKind = "coding" | "research" | "other";
export const CHECK_KINDS = ["behavior", "typecheck", "regression", "real", "source", "fact", "unverified", "other"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export type CheckResult = "pass" | "fail" | "not_run";

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

export interface TaskContract {
  /** Derived from owner-registered project scope; never copy to another task as a direct grant. */
  projectMainPolicy?: number;
  taskId: string;
  rev: number;
  kind: ContractKind;
  main_authority?: string;
  goal: string;
  acceptance: string[];
  scope: string | null;
  inputs?: string[] | null;
  outputs?: string[] | null;
  constraints?: string[] | null;
  exclusions?: string[] | null;
  forbidden: string[];
  evidence: string[];
  checks: CheckKind[];
  author: string;
  /** 작성한 직원·총괄의 id. 대표 화면에서 정했으면 null. 이름이 아니라 이 값으로 같은 사람인지 본다. */
  authorMemberId: string | null;
  /** 직원이 스스로 단 계약(worker)은 총괄·대표가 정한 계약과 갈라 보인다. */
  authorKind: ContractAuthorKind;
  sourceMessageId: string | null;
  at: string;
  /** 직원이 단 계약을 총괄·대표가 확인한 사람·시각. 확인되면 총괄 계약과 같이 완료 판정을 받는다. */
  confirmedBy?: string | null;
  confirmedByMemberId?: string | null;
  confirmedAt?: string | null;
}

/** 판정에 묶이는 계약인지: 총괄·대표가 정했거나, 직원이 단 것을 총괄·대표가 확인했다. */
export const bindingContract = (c: TaskContract | null | undefined): boolean => !!c && (c.authorKind !== "worker" || !!c.confirmedAt);

export const EXECUTION_CONTRACT_LABEL = {
  goal: "목표", inputs: "입력", outputs: "산출물", scope: "범위", constraints: "제한조건", acceptance: "완료 조건", exclusions: "제외 범위",
} as const;
export type ExecutionContractField = keyof typeof EXECUTION_CONTRACT_LABEL;

/** 새 실행의 계약 완전성만 검사한다. 작성자 권한·확인 여부는 bindingContract로 별도 확인한다. */
export function missingExecutionContractFields(contract: ContractInput | TaskContract | null | undefined): ExecutionContractField[] {
  const text = (value: unknown) => typeof value === "string" && !!value.trim();
  const list = (value: unknown, allowEmpty = false) => Array.isArray(value) && (allowEmpty || value.length > 0) && value.every(text);
  return (Object.keys(EXECUTION_CONTRACT_LABEL) as ExecutionContractField[]).filter(field => {
    const value = contract?.[field];
    return field === "goal" || field === "scope" ? !text(value) : !list(value, field === "constraints" || field === "exclusions");
  });
}

export type ContractAuthorKind = "owner" | "conductor" | "worker";

export interface ReportCheckInput {
  name: string;
  kind: CheckKind;
  result: CheckResult;
  evidence: string;
  command?: string | null;
  /** 실제 도구의 실행 위치. 생략한 과거 보고는 등록된 직원 cwd를 기준으로 한다. */
  workdir?: string | null;
  /** 이 검사가 확인한 합격 기준 번호(1부터). */
  criterion?: number | null;
}

export interface ReportCheck extends ReportCheckInput {
  messageId: string;
  taskId: string | null;
  memberId: string;
  who: string;
  runId: string | null;
  /** 이 검사가 따른 계약이 붙은 업무(갈래 업무면 위 업무). */
  contractTaskId: string | null;
  contractRev: number | null;
  at: string;
  /** 실행 증거 대조: matched(기록과 맞음)·unsupported(제공자 기록 형식 모름)·not_required(실행 검사가 아님)·null(옛 기록). */
  execStatus?: "matched" | "unsupported" | "not_required" | null;
  execRef?: string | null;
  execExit?: number | null;
  execAt?: string | null;
  execOutputSha?: string | null;
  execCommand?: string | null;
}

export type HarnessGate = "contract" | "no_contract" | "exempt";

export interface HarnessFinding {
  id: number;
  projectId: string;
  taskId: string | null;
  memberId: string | null;
  /** completion_refused 완료 차단 · evidence_missing 증거 없음 · evidence_unsupported 증거 미지원 제공자 · no_contract 계약 없는 완료 · owner_rejected 대표 거절(추정) · owner_intervened 대표가 맡긴 일에 직접 끼어듦 */
  kind: "completion_refused" | "evidence_missing" | "evidence_unsupported" | "no_contract" | "owner_rejected" | "owner_intervened";
  detail: string;
  refType: string | null;
  refId: string | null;
  at: string;
}

export const DEFAULT_CHECKS: Record<ContractKind, CheckKind[]> = {
  coding: ["behavior", "typecheck", "regression", "real"],
  research: ["source", "fact", "unverified"],
  other: [],
};

export const CHECK_LABEL: Record<CheckKind, string> = {
  behavior: "관련 동작 시험",
  typecheck: "코드 검사",
  regression: "회귀 시험",
  real: "실제 화면·실행 증거",
  source: "주장별 원문 출처",
  fact: "사실과 해석 구분",
  unverified: "미확인 항목",
  other: "기타 검사",
};

const RESULT_LABEL: Record<CheckResult, string> = { pass: "통과", fail: "실패", not_run: "실행 안 함" };

export function requiredChecks(input: Pick<ContractInput, "kind" | "checks">): CheckKind[] {
  return [...new Set(input.checks ?? DEFAULT_CHECKS[input.kind])];
}

/** 직원·총괄이 쓴 값은 한 줄로 접고 따옴표를 막는다. 줄 머리에 오지 않으므로 출처 접두어를 지어내지 못한다. */
const line = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[\\'"]/g, "\\$&");

/**
 * 지시·재개 글에 싣는 계약 덩어리. 대화 전량 대신 계약 판, 원문 참조, 그 업무의 최근 검사(보고 id), 열린 결재만 싣는다.
 */
export function formatContract(contract: TaskContract, state: { latest?: ReportCheck[]; openDecisions?: { id: string; title: string }[]; forTaskId?: string | null } = {}): string {
  const out = [`업무 계약 r${contract.rev} (#${contract.taskId}, ${contract.kind === "coding" ? "코딩" : contract.kind === "research" ? "조사" : "기타"}${contract.sourceMessageId ? `, 원문 #${contract.sourceMessageId}` : ""}, 작성 ${contract.author}${contract.authorKind === "worker" ? contract.confirmedAt ? `, 직원 작성·${contract.confirmedBy ?? "총괄"} 확인` : ", 직원 작성 계약(확인 전)" : ""})`];
  if (state.forTaskId && state.forTaskId !== contract.taskId) out.push(`- 갈래 업무 #${state.forTaskId} 는 위 업무 #${contract.taskId} 의 계약을 그대로 따른다. 갈래만 끝났으면 완료가 아니라 진행으로 올린다`);
  out.push(`- 원하는 결과: ${line(contract.goal)}`);
  for (const field of ["inputs", "outputs", "constraints", "exclusions"] as const) {
    const values = contract[field];
    if (values?.length) for (const value of values) out.push(`- ${EXECUTION_CONTRACT_LABEL[field]}: ${line(value)}`);
    else out.push(`- ${EXECUTION_CONTRACT_LABEL[field]}: ${values && (field === "constraints" || field === "exclusions") ? "없음" : "미정"}`);
  }
  contract.acceptance.forEach((a, i) => out.push(`- 합격 기준 ${i + 1}: ${line(a)}`));
  if (contract.main_authority) out.push(`- main 통합 승인 근거: ${line(contract.main_authority)}`);
  out.push(`- 자율 범위: ${contract.scope ? line(contract.scope) : "미정"}`);
  const missing = missingExecutionContractFields(contract);
  if (missing.length) out.push(`새 실행 전 총괄이 보완할 항목: ${missing.map(field => EXECUTION_CONTRACT_LABEL[field]).join(", ")}. 기존 계약의 미정 항목을 임의로 정하거나 실행 승인을 추정하지 않습니다.`);
  for (const f of contract.forbidden) out.push(`- 금지: ${line(f)}`);
  for (const e of contract.evidence) out.push(`- 필요한 증거: ${line(e)}`);
  out.push(`- 필수 검사: ${contract.checks.length ? contract.checks.map(k => `${k}(${CHECK_LABEL[k]})`).join(", ") : "없음(합격 기준만)"}`);
  out.push(`완료는 post 의 contract_rev 에 이 판 번호 ${contract.rev} 를, checks 에 검사마다 kind·result·evidence·criterion(기준 번호)을 적어야 받는다. 판이 바뀌면 옛 판의 검사로는 받지 않는다. 실패·실행 안 함이 하나라도 남으면 완료로 받지 않으니, 고쳐서 다시 검사하거나 막힘으로 올리고 unverified 에 미확인을 적는다.`);
  out.push(`실행 검사(behavior·typecheck·regression)의 통과는 command 에 실제로 돌린 명령을 적는다. 서버가 이 세션의 실행 기록에서 계약 뒤 그 명령의 마지막 실행과 종료 코드 0 을 찾는다. 파이프·;로 다른 명령을 뒤에 붙이면 종료 코드가 그 명령 것이라 받지 않는다(&& 또는 set -o pipefail).${contract.kind === "research" || contract.checks.includes("source") ? " 조사 완료는 claims 에 주장마다 basis(fact·interpretation)·source·quote(본 원문 그대로)를 적는다. 사실 주장의 인용은 계약 뒤 그 출처를 연 도구 결과나 대표·다른 직원의 자료 본문에 그대로 있어야 한다." : ""}`);
  if (state.latest?.length) {
    const by = state.latest[0]!;
    out.push(`지난 검사(보고 #${by.messageId}, ${by.who}, 계약 r${by.contractRev ?? "?"}): ${state.latest.map(c => `${c.name} ${RESULT_LABEL[c.result]}`).join(" · ")}`);
  }
  if (state.openDecisions?.length) out.push(`열린 결재: ${state.openDecisions.map(d => `#${d.id} '${line(d.title)}'`).join(", ")}`);
  return out.join("\n");
}

/** 총괄이 받는 보고 끝의 검사 한 줄. */
export function formatChecksLine(checks: ReportCheck[], contractRev: number | null, reviewNeeded: string | null, contract?: Pick<TaskContract, "taskId" | "authorKind"> | null): string {
  const parts: string[] = [];
  const which = contractRev ? `, 계약 r${contractRev}${contract?.authorKind === "worker" ? "(직원 작성 계약)" : ""}${contract && checks[0]?.taskId && contract.taskId !== checks[0].taskId ? `, 위 업무 #${contract.taskId}` : ""}` : "";
  const exec = (c: ReportCheck) => c.execStatus === "matched" ? `(실행 기록 대조: 종료 0)` : c.execStatus === "unsupported" ? "(실행 기록 미지원 제공자)" : "";
  if (checks.length) parts.push(`검사(작성자 보고${which}): ${checks.map(c => `${c.name} ${RESULT_LABEL[c.result]}${exec(c)}`).join(" · ")}`);
  if (reviewNeeded) parts.push(`독립 검토 필요: ${line(reviewNeeded)}`);
  return parts.join("\n");
}

/**
 * 완료 판정. 필수 검사 종류마다 통과 1건, 어느 검사도 실패·실행 안 함이 아님, 합격 기준마다 그 기준 번호를 단 통과 검사 1건.
 * 판 번호 대조와 갈래 업무의 계약 이어받기는 orchestrator 의 gateCompletion 이 한다. 막힘·진행은 이 판정을 받지 않는다.
 */
export function completionGate(contract: TaskContract, checks: ReportCheckInput[]): string[] {
  const reasons: string[] = [];
  for (const kind of contract.checks) {
    const mine = checks.filter(c => c.kind === kind);
    if (!mine.some(c => c.result === "pass")) reasons.push(mine.length ? `${CHECK_LABEL[kind]}(${kind})이 통과하지 않았습니다(${mine.map(c => RESULT_LABEL[c.result]).join(", ")})` : `${CHECK_LABEL[kind]}(${kind}) 검사가 없습니다`);
  }
  for (const c of checks) if (c.result === "fail") reasons.push(`'${line(c.name)}' 검사가 실패했습니다`);
  // 같은 종류에 통과가 따로 있어도 실행 안 함은 미확인으로 남는다. 완료가 아니라 막힘(unverified)으로 올린다.
  for (const c of checks) if (c.result === "not_run") reasons.push(`'${line(c.name)}' 검사를 실행하지 않았습니다(실행 안 함이 남은 완료는 받지 않습니다)`);
  contract.acceptance.forEach((a, i) => {
    if (!checks.some(c => c.criterion === i + 1 && c.result === "pass")) reasons.push(`합격 기준 ${i + 1}('${line(a).slice(0, 60)}')을 확인한 통과 검사가 없습니다`);
  });
  for (const c of checks) if (c.criterion != null && (c.criterion < 1 || c.criterion > contract.acceptance.length)) reasons.push(`'${line(c.name)}'의 criterion ${c.criterion} 은 없는 합격 기준입니다`);
  return [...new Set(reasons)];
}
