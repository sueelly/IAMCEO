// Claude 직원의 PreToolUse 훅 판정. IAMCEO가 띄울 때 넘기는 --settings 에만 걸린다(전역 설정은 바꾸지 않는다).
// 명령 글자와 파일 경로만 본다. 다른 프로그램 안에서 일어나는 지우기·읽기(스크립트 안의 삭제 등)는 막지 못한다.
// 지우기·깃허브 올리기·외부 게시는 '묻기'(대표 승인 창), 비밀 파일은 '거절'이다.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface GuardInput { tool_name?: unknown; tool_input?: unknown; cwd?: unknown }
export interface GuardContext { iamceoHome: string; userHome?: string }
export type GuardDecision = { decision: "allow" } | { decision: "deny" | "ask"; reason: string };

const DELETE_RULES: { re: RegExp; what: string }[] = [
  { re: /(^|[\s;&|(`$])(sudo\s+)?rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, what: "폴더째 지우기(rm -r)" },
  { re: /(^|[\s;&|(`$])find\s[^;&|]*\s-delete\b/, what: "find -delete" },
  { re: /(^|[\s;&|(`$])find\s[^;&|]*-exec\s+rm\b/, what: "find -exec rm" },
  { re: /(^|[\s;&|(`$])git\s+clean\s+[^;&|]*-[a-zA-Z]*f/, what: "git clean -f" },
  { re: /(^|[\s;&|(`$])git\s+reset\s+[^;&|]*--hard\b/, what: "git reset --hard" },
  { re: /(^|[\s;&|(`$])git\s+worktree\s+remove\b/, what: "워크트리 지우기" },
  { re: /(^|[\s;&|(`$])git\s+branch\s+[^;&|]*(-D|--delete\s+--force)\b/, what: "브랜치 강제 지우기" },
  { re: /(^|[\s;&|(`$])git\s+stash\s+(drop|clear)\b/, what: "git stash drop/clear" },
];
const PUBLISH_RULES: { re: RegExp; what: string }[] = [
  { re: /(^|[\s;&|(`$])git\s+push\b/, what: "깃허브에 올리기(git push)" },
  { re: /(^|[\s;&|(`$])gh\s+(pr\s+(create|merge|comment|review|close)|release\s+create|issue\s+(create|comment))\b/, what: "깃허브 게시(gh)" },
  { re: /(^|[\s;&|(`$])(npm|bun|pnpm|yarn)\s+publish\b/, what: "패키지 공개(publish)" },
];
const KEYCHAIN = /(^|[\s;&|(`$])security\s+(find-generic-password|find-internet-password|dump-keychain)\b/;

/** 비밀 파일·폴더. 홈 밑 상대 경로. 폴더는 '/'로 끝난다. */
const HOME_SECRETS = [".ssh/", ".aws/", ".gnupg/", ".config/iamceo/", ".netrc", ".git-credentials", ".npmrc", ".pgpass",
  ".claude/.credentials.json", ".codex/auth.json", ".gemini/oauth_creds.json", ".docker/config.json", ".kube/config"];
/** 경로가 어디 있든 이름만으로 비밀로 치는 것. */
const SECRET_NAMES = /(^|\/)(dev-memory-api-key|id_(rsa|dsa|ecdsa|ed25519)|[^/\s'"]+\.mcp\.json)$/;

function secretRoots(ctx: GuardContext): { dirs: string[]; files: string[] } {
  const home = ctx.userHome ?? homedir();
  const dirs: string[] = [], files: string[] = [];
  for (const rel of HOME_SECRETS) (rel.endsWith("/") ? dirs : files).push(join(home, rel.replace(/\/$/, "")));
  // IAMCEO 데이터 폴더의 접속 코드 설정과 직원 토큰(run/*.mcp.json)
  files.push(join(ctx.iamceoHome, "config.json"));
  return { dirs, files };
}

function isSecretFile(path: string, ctx: GuardContext): boolean {
  const { dirs, files } = secretRoots(ctx);
  if (SECRET_NAMES.test(path)) return true;
  return files.includes(path) || dirs.some(d => path === d || path.startsWith(`${d}/`));
}

/** 명령 글자에 비밀 경로가 나오는지. ~ · $HOME · 절대 경로 표기를 모두 본다. */
function commandTouchesSecret(command: string, ctx: GuardContext): string | null {
  const home = ctx.userHome ?? homedir();
  const spelled = command.replace(/\$\{?HOME\}?/g, home).replace(/(^|[\s'"=:(])~(?=\/)/g, `$1${home}`);
  const { dirs, files } = secretRoots(ctx);
  for (const p of [...files, ...dirs]) if (spelled.includes(p)) return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  for (const token of spelled.split(/[\s'"<>|;&()=]+/)) if (token && SECRET_NAMES.test(token)) return token;
  return null;
}

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

export function guardDecision(input: GuardInput, ctx: GuardContext): GuardDecision {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const args = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as Record<string, unknown> : {};
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd) ? input.cwd : process.cwd();
  if (tool === "Bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const secret = commandTouchesSecret(command, ctx);
    if (secret || KEYCHAIN.test(command)) return { decision: "deny", reason: `IAMCEO 하네스: 비밀 파일·키체인(${secret ?? "security"})은 읽거나 바꾸지 않습니다. 꼭 필요하면 ask 로 대표에게 물으세요` };
    for (const rule of DELETE_RULES) if (rule.re.test(command)) return { decision: "ask", reason: `IAMCEO 하네스: ${rule.what}는 되돌리기 어렵습니다. 대표 승인 창으로 넘깁니다. 임시 폴더·기존 변경은 지우지 않습니다` };
    for (const rule of PUBLISH_RULES) if (rule.re.test(command)) return { decision: "ask", reason: `IAMCEO 하네스: ${rule.what}는 밖으로 나가는 일입니다. 대표 승인 창으로 넘깁니다` };
    return { decision: "allow" };
  }
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value !== "string" || !value) continue;
    const full = resolve(cwd, value.replace(/^~(?=\/)/, ctx.userHome ?? homedir()));
    if (isSecretFile(full, ctx)) return { decision: "deny", reason: `IAMCEO 하네스: 비밀 파일(${value})은 읽거나 바꾸지 않습니다. 꼭 필요하면 ask 로 대표에게 물으세요` };
  }
  return { decision: "allow" };
}

/** Claude Code PreToolUse 훅 출력. 허용이면 아무것도 내지 않는다(다른 권한 판정을 그대로 둔다). */
export function hookOutput(decision: GuardDecision): string | null {
  if (decision.decision === "allow") return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.decision, permissionDecisionReason: decision.reason } });
}
