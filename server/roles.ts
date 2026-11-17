import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemberKind } from "../shared/types.ts";
import boundaryConductor from "./roles/boundary-conductor.md" with { type: "text" };
import boundaryRoot from "./roles/boundary-root.md" with { type: "text" };
import boundaryWorker from "./roles/boundary-worker.md" with { type: "text" };
import conductor from "./roles/conductor.md" with { type: "text" };
import root from "./roles/root.md" with { type: "text" };
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

/** 기본 역할 글 = 종류별 글 + 공통 글 지침. 세 CLI 모두 이 글을 시스템 프롬프트 파일로 받는다. */
function withGuide(role: string): string {
  return `${role.trimEnd()}\n\n${WRITING_GUIDE.trim()}\n`;
}

const BUILT_IN: Record<MemberKind, string> = { conductor: withGuide(conductor), root: withGuide(root), worker: withGuide(worker) };

/** 이름 뒤 조사. 받침이 없으면 가·를·는, 있으면 이·을·은. 한글이 아닌 끝은 받침 없는 것으로 친다. */
export function josa(name: string, withFinal: "이" | "을" | "은"): string {
  const code = name.charCodeAt(name.length - 1) - 0xac00;
  const hasFinal = code >= 0 && code <= 11171 && code % 28 !== 0;
  return name + (hasFinal ? withFinal : { 이: "가", 을: "를", 은: "는" }[withFinal]);
}

const warned = new Set<string>();

/**
 * 종류별 역할 경계(대표 2026-11-17 "총괄은 앞으로 구현은 맡지말고 시키고 합치고 판단하고 설계하는 일 까지만 맡도록 해"):
 * 총괄은 설계·맡김·판단·검증 뒤 메인 합치기, 직원은 작업 브랜치 납품까지, 본사는 프로젝트의 구현·합치기를 떠안지 않는다.
 * 고쳐 쓴 템플릿도 기본 글 전체를 대체하지만 이 경계는 빠지지 않는다: `{{ROLE_BOUNDARY}}` 자리가 있으면 그 자리, 없으면 끝에 붙는다.
 */
export const ROLE_BOUNDARY: Record<MemberKind, string> = { conductor: boundaryConductor, root: boundaryRoot, worker: boundaryWorker };

function withBoundary(template: string, kind: MemberKind): string {
  const text = ROLE_BOUNDARY[kind].trim();
  return template.includes("{{ROLE_BOUNDARY}}") ? template.replaceAll("{{ROLE_BOUNDARY}}", () => text) : `${template.trimEnd()}\n\n${text}\n`;
}

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
 * 고쳐 쓴 템플릿은 기본 규칙 전체를 대체하므로 글 지침도 붙이지 않는다. `iamceo roles export` 로 꺼낸 예시에는 지침이 들어 있다.
 */
export function renderRole(kind: MemberKind, vars: RoleVars, rolesDir?: string): string {
  const custom = rolesDir ? join(rolesDir, `${kind}.md`) : null;
  const useCustom = !!custom && existsSync(custom);
  const raw = useCustom ? readFileSync(custom, "utf8") : BUILT_IN[kind];
  // 승인 규칙 경고는 고쳐 쓴 글 그대로 본다(경계 글의 낱말로 경고가 사라지지 않게).
  if (useCustom && !warned.has(custom) && !raw.includes("승인")) {
    warned.add(custom);
    console.warn(`역할 템플릿 ${custom} 에 승인 규칙이 없습니다. 기본 규칙 전체를 대체하므로 직원이 승인 없이 일할 수 있습니다. 'iamceo roles export' 로 기본 규칙을 꺼내 고치세요`);
  }
  const template = withBoundary(raw, kind);
  // 줄이 통째로 자리표시면 비었을 때 빈 줄을 남기지 않는다. 고쳐 쓴 템플릿에 자리표시가 없어도 규칙은 빠지지 않게 끝에 붙인다.
  const place = (text: string, key: "SUBAGENT_EFFORT" | "MEMORY", value: string, gap: string): string =>
    text.includes(`{{${key}}}`) ? (value ? text : text.replace(new RegExp(`^[ \\t]*\\{\\{${key}\\}\\}[ \\t]*\\n?`, "gm"), "")) : value ? `${text.trimEnd()}${gap}${value}\n` : text;
  const placed = place(place(template, "SUBAGENT_EFFORT", vars.SUBAGENT_EFFORT ?? "", "\n"), "MEMORY", vars.MEMORY ?? "", "\n\n");
  return placed.replace(/\{\{(PROJECT|NAME|ROLE|CONDUCTOR|SUBAGENT_EFFORT|MEMORY)\}\}/g, (_, key: keyof RoleVars) => vars[key] ?? "");
}
