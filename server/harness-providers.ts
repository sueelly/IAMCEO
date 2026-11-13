// 제공자별 실행 제한 설정(준비만). 아직 직원 실행 인자에 연결하지 않는다. 연결은 대표 결정 뒤 따로 한다.
// 근거: 설치된 판(Claude Code 2.1.323, codex-cli 0.167.0, agy 1.5.8)의 도움말·공식 문서, codex sandbox 격리 확인(모델 호출 없음).
// - Claude: 샌드박스는 Bash·PowerShell·Monitor 에만 걸린다. Read·Edit·WebFetch·MCP·훅은 밖이다(그쪽은 PreToolUse 훅이 본다).
//   bypassPermissions 에서는 허용 목록 밖 주소도 나가므로 strictAllowlist 가 있어야 막힌다. allowUnsandboxedCommands:false 로 밖에서 다시 돌리기를 끈다.
// - Codex: workspace-write 는 cwd 밖 쓰기·지우기와 네트워크를 막지만 읽기는 막지 않는다. 기본으로 /tmp·TMPDIR 쓰기를 열어 둔다.
//   PreToolUse 훅은 deny 만 된다(ask 는 '읽지만 아직 지원 안 함'). 사용자·저장소 훅은 해시로 신뢰를 받아야 돈다.
// - Antigravity: --sandbox(터미널 제한)가 있으나 범위 문서가 없고 모델 없이 시험할 길이 없어 미확인이다.
import { homedir } from "node:os";
import { join } from "node:path";
import { guardDecision, type GuardContext, type GuardDecision } from "./harness-guard.ts";

/** 홈 밑 비밀 위치(하네스 훅과 같은 목록). 샌드박스 denyRead 에 넣는다. */
const HOME_SECRET_PATHS = [".ssh", ".aws", ".gnupg", ".config/iamceo", ".config/gh", ".iamceo", "Library/Keychains", ".netrc", ".git-credentials", ".npmrc", ".pgpass",
  ".claude.json", ".claude/.credentials.json", ".codex/auth.json", ".gemini/oauth_creds.json", ".docker/config.json", ".kube/config"];

/**
 * Claude --settings 에 더할 샌드박스. Bash 의 쓰기를 cwd·임시 폴더로, 네트워크를 허용 목록으로, 비밀 위치 읽기를 막는다.
 * 대가: 허용 목록 밖 설치·내려받기(bun install, git fetch 등)가 막힌다. allowedDomains 에 필요한 곳을 넣어야 한다.
 */
export function claudeSandboxSettings(o: { iamceoHome: string; userHome?: string; allowedDomains?: string[] }): Record<string, unknown> {
  const home = o.userHome ?? homedir();
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [o.iamceoHome, ...HOME_SECRET_PATHS.map(p => join(home, p))],
        allowRead: [join(o.iamceoHome, "inbox"), join(o.iamceoHome, "roles")],
      },
      network: { allowedDomains: o.allowedDomains ?? [], strictAllowlist: true },
    },
  };
}

/**
 * Codex 실행 인자: 승인·샌드박스를 통째로 끄는 대신 workspace-write 샌드박스(cwd 밖 쓰기·네트워크 막음)를 쓴다.
 * /tmp·TMPDIR 쓰기를 닫아야 cwd 밖 쓰기가 실제로 막힌다(격리 확인). 읽기는 막지 못한다.
 * 대가: 네트워크가 필요한 명령(설치·git fetch·push)이 실패한다. network_access=true 면 네트워크는 열린다.
 */
export function codexSandboxArgs(o: { network?: boolean } = {}): string[] {
  return ["--sandbox", "workspace-write", "--ask-for-approval", "never",
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c", `sandbox_workspace_write.network_access=${o.network ? "true" : "false"}`];
}

const tomlString = (v: string) => JSON.stringify(v);

/**
 * Codex PreToolUse 훅(같은 판정 모듈, --codex 출력). config 의 [hooks] 를 -c 로 넘긴다.
 * 이 훅은 비관리 훅이라 신뢰(해시 검토)를 받거나 --dangerously-bypass-hook-trust 가 있어야 돈다. 그 깃발은 저장소의 다른 훅도 검토 없이 돌린다.
 */
export function codexHookArgs(guard: string): string[] {
  return ["-c", "features.hooks=true",
    "-c", `hooks.PreToolUse=[{matcher=${tomlString("^(Bash|apply_patch)$")},hooks=[{type="command",command=${tomlString(guard)},timeout=10}]}]`];
}

/** apply_patch 글에서 건드리는 파일 경로(Add·Update·Delete·Move to). */
export function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1]!.trim());
}

/**
 * Codex 훅 판정. Bash 는 Claude 와 같은 셸 판정, apply_patch 는 고치는 파일 경로를 비밀 위치와 대조한다.
 * Codex 는 '묻기'를 지원하지 않으므로 묻기는 거절로 바꾸고, 대표에게 ask 로 물으라고 적는다.
 */
export function codexGuardDecision(input: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown }, ctx: GuardContext): GuardDecision {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const args = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as Record<string, unknown> : {};
  let decision: GuardDecision = { decision: "allow" };
  if (tool === "Bash") decision = guardDecision({ tool_name: "Bash", tool_input: { command: typeof args.command === "string" ? args.command : "" }, cwd: input.cwd }, ctx);
  else if (tool === "apply_patch" && typeof args.command === "string") {
    for (const path of patchPaths(args.command)) {
      const d = guardDecision({ tool_name: "Write", tool_input: { file_path: path }, cwd: input.cwd }, ctx);
      if (d.decision !== "allow") { decision = d; break; }
    }
  }
  if (decision.decision === "ask") return { decision: "deny", reason: `${decision.reason} (Codex 는 승인 창이 없어 거절합니다. 꼭 필요하면 ask 로 대표에게 묻고 결과를 보고하세요)` };
  return decision;
}

/** Codex 훅 출력: 거절만 낸다(허용이면 아무것도 내지 않는다). */
export function codexHookOutput(decision: GuardDecision): string | null {
  if (decision.decision === "allow") return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } });
}

/** 보고·자료에 싣는 제공자별 제한 표(설치 판·문서·격리 확인 기준). */
export const PROVIDER_LIMITS = [
  { provider: "Claude 2.1.323", hook: "PreToolUse 훅 연결됨(묻기·거절)", sandbox: "설정 준비(연결 안 함): Bash 쓰기·네트워크·비밀 읽기", untested: "실제 세션에서 묻기 창·샌드박스 동작" },
  { provider: "Codex 0.167.0", hook: "PreToolUse 훅 준비(연결 안 함): 거절만, 신뢰 필요", sandbox: "workspace-write 격리 확인: 밖 쓰기·지우기·로컬 연결 막힘, 읽기는 됨", untested: "실제 세션에서 훅이 도는지" },
  { provider: "Antigravity 1.5.8", hook: "없음", sandbox: "--sandbox 있음, 범위 미확인", untested: "전부(모델 없이 시험할 길 없음)" },
] as const;
