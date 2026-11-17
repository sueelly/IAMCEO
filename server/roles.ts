import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemberKind } from "../shared/types.ts";
import conductor from "./roles/conductor.md" with { type: "text" };
import coordination from "./roles/coordination.md" with { type: "text" };
import root from "./roles/root.md" with { type: "text" };
import terminalApproval from "./roles/terminal-approval.md" with { type: "text" };
import worker from "./roles/worker.md" with { type: "text" };
import writing from "./roles/writing.md" with { type: "text" };

export interface RoleVars {
  PROJECT: string;
  NAME: string;
  ROLE: string;
  CONDUCTOR: string;
  /** 서브에이전트 effort 규칙 한 줄. 정하지 않았으면 빈 글. */
  SUBAGENT_EFFORT?: string;
  /** 개발 기억 운영 단락. 기억이 켜진 프로젝트에만 들어가고, 아니면 빈 글. */
  MEMORY?: string;
}

/** 대표에게 보이는 글 지침. 모든 직원 종류와 CLI(Claude·Codex·Antigravity)의 역할 글 끝에 한 번 붙는다. */
export const WRITING_GUIDE: string = writing;

/**
 * 터미널 승인 창 안내(대표 2026-11-17 "전체에 적용해. 프롬프트에 적용해서 앞으로도 그렇게 하도록").
 * 모든 직원 종류와 세 CLI 에 들어간다. 고쳐 쓴 템플릿에 `{{TERMINAL_APPROVAL}}` 자리가 없어도 끝에 붙어 빠지지 않는다.
 */
export const TERMINAL_APPROVAL_GUIDE: string = terminalApproval;

/** 총괄의 역할 경계는 사용자 정의 템플릿으로도 빠지지 않는다. 제품 제작 지시보다 우선한다. */
export const COORDINATION_GUIDE: string = coordination;

/** 기본 역할 글 = 종류별 글 + 공통 글 지침. 세 CLI 모두 이 글을 시스템 프롬프트 파일로 받는다. */
export function renderFinalReviewer(project: string): string {
  return withGuide(`당신은 '${project}' 프로젝트의 독립 최종 검수 담당자입니다.
하네스가 수행 완료로 판정한 직원 보고만 검수합니다. 받은 업무 ID와 통과 보고 ID로 task_review_evidence에서 현재 계약, 보고 원문, 하네스의 검사 근거를 확인하세요. post의 report_id 조회로 보고에 연결된 자료 원문을 확인할 수 있습니다. Git 작업은 커밋의 변경분을 끝까지 읽으세요. 파일을 골라 읽거나 nextOffset으로 이어서 확인할 수 있습니다. 독립적으로 조회할 수 없는 근거는 확인한 것으로 기록하지 않습니다.
한 번에 받은 검수 묶음은 항목별로 판정하세요. 원래 기준과 근거를 확인하면 task_review에서 confirmed를, 근거가 유효한 상태에서 새 결함을 찾으면 confirmed_with_repair를 남깁니다. 원래 기준이나 근거가 성립하지 않으면 changes_requested를 남깁니다. 수정할 부분에 원인·근거와 업무 이름을 적으세요.
검증된 작업 브랜치를 main에 통합할 업무는 직원 완료 보고가 가리키는 artifact의 전체 커밋 SHA를 확인하고 reviewed_commit에 적습니다. 일반 후속 업무는 검수와 동시에 진행됩니다.
제품 구현과 수정, 커밋·푸시·병합·브랜치 삭제는 배정받은 다른 담당자의 업무입니다. 검수 결과를 총괄에게 연결하며 별도 지시를 내리거나 승인하지 않습니다.`);
}

function withGuide(role: string): string {
  return `${role.trimEnd()}\n\n${WRITING_GUIDE.trim()}\n`;
}

const BUILT_IN: Record<MemberKind, string> = { conductor: withGuide(`${conductor.trimEnd()}\n\n{{COORDINATION}}\n`), root: withGuide(root), worker: withGuide(worker) };

/** 이름 뒤 조사. 받침이 없으면 가·를·는, 있으면 이·을·은. 한글이 아닌 끝은 받침 없는 것으로 친다. */
export function josa(name: string, withFinal: "이" | "을" | "은"): string {
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  const hasFinal = code >= 0 && code <= 11171 && code % 28 !== 0;
  return name + (hasFinal ? withFinal : { 이: "가", 을: "를", 은: "는" }[withFinal]);
}

const warned = new Set<string>();

/** 기본 템플릿을 고쳐 쓸 수 있게 꺼낸다. `<kind>.example.md` 는 읽히지 않고, `<kind>.md` 로 이름을 바꾸면 쓰인다. */
export function exportRoles(rolesDir: string): string[] {
  mkdirSync(rolesDir, { recursive: true, mode: 0o700 });
  return (Object.keys(BUILT_IN) as MemberKind[]).map((kind) => {
    const path = join(rolesDir, `${kind}.example.md`);
    writeFileSync(path, BUILT_IN[kind]);
    return path;
  });
}

/**
 * `<rolesDir>/<kind>.md` 가 있으면 그것을 쓴다(spec §8). 값 안의 {{...}} 는 다시 치환하지 않는다.
 * 고쳐 쓴 템플릿도 최신 공통 글 지침을 받는다. 터미널 승인 안내와 총괄의 필수 조정 규칙도 보존한다.
 * `iamceo roles export` 로 꺼낸 예시에는 지침이 들어 있다.
 */
export function renderRole(kind: MemberKind, vars: RoleVars, rolesDir?: string): string {
  const custom = rolesDir ? join(rolesDir, `${kind}.md`) : null;
  const useCustom = !!custom && existsSync(custom);
  const template = useCustom ? readFileSync(custom, "utf8") : BUILT_IN[kind];
  if (useCustom && !warned.has(custom) && !template.includes("승인")) {
    warned.add(custom);
    console.warn(`역할 템플릿 ${custom} 에 승인 규칙이 없습니다. 기본 규칙 전체를 대체하므로 직원이 승인 없이 일할 수 있습니다. 'iamceo roles export' 로 기본 규칙을 꺼내 고치세요`);
  }
  // 줄이 통째로 자리표시면 비었을 때 빈 줄을 남기지 않는다. 고쳐 쓴 템플릿에 자리표시가 없어도 규칙은 빠지지 않게 끝에 붙인다.
  const place = (text: string, key: "SUBAGENT_EFFORT" | "MEMORY" | "TERMINAL_APPROVAL" | "COORDINATION", value: string, gap: string): string =>
    text.includes(`{{${key}}}`) ? (value ? text : text.replace(new RegExp(`^[ \\t]*\\{\\{${key}\\}\\}[ \\t]*\\n?`, "gm"), "")) : value ? `${text.trimEnd()}${gap}${value}\n` : text;
  const approval = TERMINAL_APPROVAL_GUIDE.trim();
  const coordination = kind === "conductor" ? COORDINATION_GUIDE.trim() : "";
  const placed = place(place(place(place(template, "SUBAGENT_EFFORT", vars.SUBAGENT_EFFORT ?? "", "\n"), "MEMORY", vars.MEMORY ?? "", "\n\n"), "TERMINAL_APPROVAL", approval, "\n\n"), "COORDINATION", coordination, "\n\n");
  const values: Record<string, string | undefined> = { ...vars, TERMINAL_APPROVAL: approval, COORDINATION: coordination };
  const rendered = placed.replace(/\{\{(PROJECT|NAME|ROLE|CONDUCTOR|SUBAGENT_EFFORT|MEMORY|TERMINAL_APPROVAL|COORDINATION)\}\}/g, (_, key: string) => values[key] ?? "");
  return rendered.includes(WRITING_GUIDE.trim()) ? rendered : withGuide(rendered);
}
