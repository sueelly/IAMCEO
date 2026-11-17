import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemberKind } from "../shared/types.ts";
import boundaryConductor from "./roles/boundary-conductor.md" with { type: "text" };
import boundaryRoot from "./roles/boundary-root.md" with { type: "text" };
import boundaryWorker from "./roles/boundary-worker.md" with { type: "text" };
import conductor from "./roles/conductor.md" with { type: "text" };
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
 * 고쳐 쓴 템플릿도 기본 글 전체를 대체하지만 이 경계는 빠지지 않고 한 번만 든다: `{{ROLE_BOUNDARY}}` 자리가 있으면 첫 자리, 없으면 끝에 붙는다.
 */
export const ROLE_BOUNDARY: Record<MemberKind, string> = { conductor: boundaryConductor, root: boundaryRoot, worker: boundaryWorker };

const BOUNDARY_SLOT = "{{ROLE_BOUNDARY}}";
/** 남는 경계 자리표시를 지운다. 줄이 통째로 자리표시면 그 줄을 지워 빈 줄을 남기지 않는다. */
const dropSlots = (text: string): string => text.replace(/^[ \t]*\{\{ROLE_BOUNDARY\}\}[ \t]*(?:\r?\n|$)/gm, "").replaceAll(BOUNDARY_SLOT, "");

/** 코드 블록(``` 또는 ~~~ 펜스) 범위. 닫히지 않은 펜스는 글 끝까지. 인용·예시로 든 코드 블록 안의 글은 실제 지침으로 치지 않는다. */
function fencedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open: { at: number; mark: string } | null = null;
  for (const m of text.matchAll(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm)) {
    const mark = m[1]!;
    if (!open) open = { at: m.index!, mark };
    else if (mark[0] === open.mark[0] && mark.length >= open.mark.length && !/\S/.test(m[0].trim().slice(mark.length))) {
      ranges.push([open.at, m.index! + m[0].length]);
      open = null;
    }
  }
  if (open) ranges.push([open.at, text.length]);
  return ranges;
}

/**
 * 글 안에서 value 가 실제 지침으로 서 있는 자리들. 줄 머리에서 시작해 줄 끝에서 끝나고, 코드 블록 밖이어야 한다.
 * 문장 안의 인용(«…»)·예시·부분 일치·코드 블록 안 사본은 치지 않는다. 사용자 글에 같은 글자가 있다는 이유만으로 지우거나 빼지 않는다.
 */
function standalone(text: string, value: string): number[] {
  if (!value) return [];
  const fenced = fencedRanges(text);
  const found: number[] = [];
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
    const end = at + value.length;
    const lineStart = at === 0 || text[at - 1] === "\n";
    const lineEnd = end === text.length || text[end] === "\n" || text.startsWith("\r\n", end) || value.endsWith("\n");
    if (lineStart && lineEnd && !fenced.some(([from, to]) => at >= from && at < to)) found.push(at);
  }
  return found;
}

/**
 * 템플릿(값을 넣기 전)에 지금 역할 경계를 한 번만 둔다. 값 안의 `{{ROLE_BOUNDARY}}`·`{{NAME}}` 은 여기 오지 않으므로 건드리지 않는다.
 * - 같은 경계 글이 실제 지침으로(줄 단위·코드 블록 밖) 이미 들어 있으면(완성된 역할 글을 고친 템플릿으로 다시 쓴 경우) 첫 사본만 남긴다.
 *   지우는 것은 뒤의 실제 사본과 남은 자리표시뿐이다. 코드 블록·문장 안의 인용은 그대로 둔다.
 * - 자리표시가 있으면 첫 자리에 넣고 나머지 자리는 지운다.
 * - 둘 다 없으면(인용·예시에만 있어도) 끝에 실제 경계를 붙인다.
 */
function withBoundary(template: string, kind: MemberKind): string {
  const text = ROLE_BOUNDARY[kind].trim();
  const active = standalone(template, text);
  if (active.length) {
    let out = "", from = 0;
    for (const [i, at] of active.entries()) {
      out += dropSlots(template.slice(from, at)) + (i === 0 ? text : "");
      from = at + text.length;
    }
    return out + dropSlots(template.slice(from));
  }
  const slot = template.indexOf(BOUNDARY_SLOT);
  if (slot >= 0) return `${template.slice(0, slot)}${text}${dropSlots(template.slice(slot + BOUNDARY_SLOT.length))}`;
  return `${template.trimEnd()}\n\n${text}\n`;
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
 * 고쳐 쓴 템플릿은 기본 규칙 전체를 대체하므로 글 지침도 붙이지 않는다. 터미널 승인 안내는 빠지지 않게 끝에 붙인다(자리표시가 있으면 그 자리).
 * `iamceo roles export` 로 꺼낸 예시에는 지침이 들어 있다.
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
  const approval = TERMINAL_APPROVAL_GUIDE.trim();
  // 경계 → effort·기억 → 터미널 승인 안내 차례로 둔다. 셋 다 자리표시가 있으면 그 자리, 없으면 끝에 붙인다.
  const appended: ["SUBAGENT_EFFORT" | "MEMORY" | "TERMINAL_APPROVAL", string, string][] = [
    ["SUBAGENT_EFFORT", vars.SUBAGENT_EFFORT ?? "", "\n"], ["MEMORY", vars.MEMORY ?? "", "\n\n"], ["TERMINAL_APPROVAL", approval, "\n\n"],
  ];
  // 줄이 통째로 자리표시인데 값이 비었으면 빈 줄을 남기지 않는다.
  let text = template;
  for (const [key, value] of appended) if (!value) text = text.replace(new RegExp(`^[ \\t]*\\{\\{${key}\\}\\}[ \\t]*\\n?`, "gm"), "");
  // 자리표시는 템플릿에서만 한 번 바꾼다. 값 안의 {{...}} 는 다시 읽지 않는다.
  const values: Record<string, string | undefined> = { ...vars, TERMINAL_APPROVAL: approval };
  const fill = (part: string): string => part.replace(/\{\{(PROJECT|NAME|ROLE|CONDUCTOR|SUBAGENT_EFFORT|MEMORY|TERMINAL_APPROVAL)\}\}/g, (_, key: string) => values[key] ?? "");
  const filled = fill(text);
  // 자리표시가 없는 고친 템플릿에도 규칙이 빠지지 않게 끝에 붙인다. 바꾼 뒤에 붙여 값 안의 자리표시를 그대로 둔다.
  // 같은 글이 이미 실제 지침으로(줄 단위·코드 블록 밖) 있으면(완성된 역할 글을 다시 쓴 경우) 다시 붙이지 않는다. 문장 안 예시·인용은 치지 않는다.
  let tail = "";
  for (const [key, value, gap] of appended) {
    if (!value || template.includes(`{{${key}}}`) || standalone(filled + tail, value).length) continue;
    tail += `${gap}${value}`;
  }
  // 끝 공백은 템플릿 글에서만 정리한다. 넣은 값의 앞뒤 공백은 그대로 둔다.
  return tail ? `${fill(text.trimEnd())}${tail}\n` : filled;
}
