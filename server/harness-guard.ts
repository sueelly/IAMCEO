// Claude 직원의 PreToolUse 훅 판정. IAMCEO가 띄울 때 넘기는 --settings 에만 걸린다(전역 설정은 바꾸지 않는다).
// 셸 명령은 따옴표·이스케이프·$( )·백틱·bash -c·eval·xargs·find -exec 를 풀어 '명령 자리'의 낱말만 본다.
// 그래서 따옴표 안의 설명문(git commit -m "…rm -rf…", echo '…git push…')은 명령으로 치지 않는다.
//
// 묻기(대표 승인 창): rm -r 류, find -delete·-exec rm, git clean -f·reset --hard·worktree remove·branch -D·stash drop/clear,
//   작업 중 변경을 버리는 git restore·checkout -- ·switch --discard-changes, git push,
//   gh pr·issue·release·repo·gist 의 쓰기 하위 명령, gh api 의 쓰기 표시(-X POST 등·-f 필드), npm·bun·pnpm·yarn publish.
// 거절: 홈의 키·토큰 파일과 폴더, IAMCEO 데이터 폴더 전체(직원 첨부 inbox·역할 roles 는 읽는다), 그 폴더를 품은 상위 폴더의 통째 검색·복사, 키체인 읽기.
// 못 막는 것: curl·wget 같은 다른 네트워크 도구, 외부 MCP 도구(mcp__…, 훅 대상이 아니다), 스크립트·프로그램 안의 지우기·읽기,
//   변수로 지은 경로, 셸 파일 실행, 파이프로 셸에 넘긴 글. 이 훅은 셸 전체를 통제하지 않는다.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface GuardInput { tool_name?: unknown; tool_input?: unknown; cwd?: unknown }
export interface GuardContext { iamceoHome: string; userHome?: string }
export type GuardDecision = { decision: "allow" } | { decision: "deny" | "ask"; reason: string };

/** 홈 밑 비밀 파일·폴더. 폴더는 '/'로 끝난다. */
const HOME_SECRETS = [".ssh/", ".aws/", ".gnupg/", ".config/iamceo/", ".config/gh/", ".iamceo/", "Library/Keychains/", ".netrc", ".git-credentials", ".npmrc", ".pgpass",
  ".claude.json", ".claude/.credentials.json", ".codex/auth.json", ".gemini/oauth_creds.json", ".docker/config.json", ".kube/config"];
/** IAMCEO 데이터 폴더 안에서 직원이 읽어야 하는 곳(대표 첨부, 역할 글). 나머지(DB·접속 코드·직원 토큰·백업)는 비밀이다. */
const IAMCEO_OPEN = ["inbox", "roles"];
/** 경로가 어디 있든 이름만으로 비밀로 치는 것. */
const SECRET_NAMES = /^(dev-memory-api-key|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|[^/]+\.mcp\.json)$/;

interface Roots { dirs: string[]; files: string[]; open: string[] }

function real(path: string): string {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

function secretRoots(ctx: GuardContext): Roots {
  const home = ctx.userHome ?? homedir();
  const dirs: string[] = [], files: string[] = [], open: string[] = [];
  for (const rel of HOME_SECRETS) (rel.endsWith("/") ? dirs : files).push(join(home, rel.replace(/\/$/, "")));
  for (const h of [ctx.iamceoHome, join(home, ".iamceo")]) {
    dirs.push(h);
    for (const o of IAMCEO_OPEN) open.push(join(h, o));
  }
  // 바로가기(심볼릭 링크)로 옮긴 폴더도 같은 곳으로 본다.
  const withReal = (list: string[]) => [...new Set(list.flatMap(p => [p, real(p)]))];
  return { dirs: withReal(dirs), files: withReal(files), open: withReal(open) };
}

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

/** 비밀 파일·폴더 안의 경로인지. 글자 그대로와 실제 위치를 모두 본다. */
function isSecretPath(path: string, roots: Roots): boolean {
  if (SECRET_NAMES.test(basename(path))) return true;
  return [path, real(path)].some(p => !roots.open.some(o => inside(p, o)) && (roots.files.includes(p) || roots.dirs.some(d => inside(p, d))));
}

/** 비밀 폴더를 품은 상위 폴더인지(통째 검색·복사가 그 안을 지난다). */
function holdsSecret(path: string, roots: Roots): boolean {
  return [path, real(path)].some(p => [...roots.dirs, ...roots.files].some(r => r !== p && inside(r, p)));
}

// ---- 글로브(*, ?, [..], **) 경로 ----
const hasGlob = (s: string) => /[*?[]/.test(s);
function segMatch(pattern: string, seg: string): boolean {
  if (!hasGlob(pattern)) return pattern === seg;
  const re = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\[!/g, "[^");
  try { return new RegExp(`^${re}$`).test(seg); } catch { return true; }
}
/** 글로브가 root 안을 가리킬 수 있으면 inside, root 의 상위까지만 맞으면 above. */
function globReach(pattern: string, root: string): "inside" | "above" | null {
  const ps = pattern.split("/").filter(Boolean), rs = root.split("/").filter(Boolean);
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === "**" || i >= rs.length) return "inside";
    if (!segMatch(ps[i]!, rs[i]!)) return null;
  }
  return ps.length >= rs.length ? "inside" : "above";
}
function globTouches(pattern: string, roots: Roots): "inside" | "above" | null {
  if (SECRET_NAMES.test(basename(pattern))) return "inside";
  const segs = pattern.split("/").filter(Boolean);
  const cut = segs.findIndex(hasGlob);
  const prefix = `/${segs.slice(0, cut < 0 ? segs.length : cut).join("/")}`;
  if (roots.open.some(o => inside(prefix, o))) return null;
  let best: "inside" | "above" | null = null;
  for (const r of [...roots.dirs, ...roots.files]) {
    const reach = globReach(pattern, r);
    if (reach === "inside") return "inside";
    if (reach === "above") best = "above";
  }
  return best;
}

// ---- 셸 낱말 풀기 ----
interface SimpleCommand { words: string[]; redirects: string[]; heredocs: string[] }

function captureParen(src: string, start: number): [string, number] {
  let depth = 1, i = start;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j + 1; continue; }
    if (c === '"') { i++; while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1; i++; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return [src.slice(start, i), i + 1];
    i++;
  }
  return [src.slice(start), src.length];
}
function captureBacktick(src: string, start: number): [string, number] {
  let i = start;
  while (i < src.length && src[i] !== "`") i += src[i] === "\\" ? 2 : 1;
  return [src.slice(start, i), i + 1];
}
function expandVar(src: string, i: number, home: string): [string, number] {
  const m = /^\$(\{HOME\}|HOME(?![A-Za-z0-9_]))/.exec(src.slice(i, i + 8));
  if (m) return [home, i + m[0].length];
  const v = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|.)?/.exec(src.slice(i))![0];
  return [v, i + Math.max(1, v.length)];
}

/** 셸 글을 단순 명령들로 나눈다. $( )·백틱·<( ) 안의 글은 nested 로 따로 돌려준다. */
function parseShell(src: string, home: string): { commands: SimpleCommand[]; nested: string[] } {
  const commands: SimpleCommand[] = [], nested: string[] = [];
  let cmd: SimpleCommand = { words: [], redirects: [], heredocs: [] };
  let word: string | null = null;
  let next: "arg" | "redirect" | "heredoc" | "heredoc-strip" | "herestring" = "arg";
  const pending: { delim: string; strip: boolean; cmd: SimpleCommand }[] = [];
  const add = (s: string) => { word = (word ?? "") + s; };
  const endWord = () => {
    if (word === null) return;
    if (next === "heredoc" || next === "heredoc-strip") pending.push({ delim: word, strip: next === "heredoc-strip", cmd });
    else if (next === "herestring") cmd.heredocs.push(word);
    else if (next === "redirect") cmd.redirects.push(word);
    else cmd.words.push(word);
    next = "arg"; word = null;
  };
  const endCommand = () => {
    endWord();
    if (cmd.words.length || cmd.redirects.length || cmd.heredocs.length) commands.push(cmd);
    cmd = { words: [], redirects: [], heredocs: [] }; next = "arg";
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\\") { if (src[i + 1] !== "\n") add(src[i + 1] ?? ""); i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1), end = j < 0 ? n : j; add(src.slice(i + 1, end)); i = end + 1; continue; }
    if (c === '"') {
      i++;
      let buf = "";
      while (i < n && src[i] !== '"') {
        const d = src[i]!;
        if (d === "\\" && i + 1 < n && '"\\$`\n'.includes(src[i + 1]!)) { if (src[i + 1] !== "\n") buf += src[i + 1]; i += 2; continue; }
        if (d === "$" && src[i + 1] === "(") { const [code, to] = captureParen(src, i + 2); if (!code.startsWith("(")) nested.push(code); buf += "$(…)"; i = to; continue; }
        if (d === "`") { const [code, to] = captureBacktick(src, i + 1); nested.push(code); buf += "`…`"; i = to; continue; }
        if (d === "$") { const [text, to] = expandVar(src, i, home); buf += text; i = to; continue; }
        buf += d; i++;
      }
      i++; add(buf); continue;
    }
    if (c === "$" && src[i + 1] === "(") { const [code, to] = captureParen(src, i + 2); if (!code.startsWith("(")) nested.push(code); add("$(…)"); i = to; continue; }
    if (c === "`") { const [code, to] = captureBacktick(src, i + 1); nested.push(code); add("`…`"); i = to; continue; }
    if ((c === "<" || c === ">") && src[i + 1] === "(") { const [code, to] = captureParen(src, i + 2); nested.push(code); add("<(…)"); i = to; continue; }
    if (c === "$") { const [text, to] = expandVar(src, i, home); add(text); i = to; continue; }
    if (c === "~" && word === null && (i + 1 >= n || /[/\s;&|)]/.test(src[i + 1]!))) { add(home); i++; continue; }
    if (c === "#" && word === null) { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "<" || c === ">") {
      if (word !== null && /^\d+$/.test(word)) word = null; else endWord();
      if (c === "<" && src[i + 1] === "<" && src[i + 2] === "<") { i += 3; next = "herestring"; continue; }
      if (c === "<" && src[i + 1] === "<") { i += 2; if (src[i] === "-") { i++; next = "heredoc-strip"; } else next = "heredoc"; continue; }
      i++;
      while (src[i] === ">" || src[i] === "&" || src[i] === "|") i++;
      next = "redirect"; continue;
    }
    if (c === "\n") {
      endCommand(); i++;
      // 다음 줄부터는 here-doc 본문이다(명령이 아니다). 셸에 먹이는 본문만 따로 본다.
      while (pending.length) {
        const h = pending.shift()!, lines: string[] = [];
        while (i < n) {
          const e = src.indexOf("\n", i), end = e < 0 ? n : e, raw = src.slice(i, end);
          i = end + 1;
          if ((h.strip ? raw.replace(/^\t+/, "") : raw) === h.delim) break;
          lines.push(raw);
        }
        h.cmd.heredocs.push(lines.join("\n"));
      }
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") { endCommand(); i++; continue; }
    if (c === " " || c === "\t") { endWord(); i++; continue; }
    add(c); i++;
  }
  endCommand();
  return { commands, nested };
}

// ---- 명령 판정 ----
const KEYWORDS = new Set(["{", "}", "!", "then", "do", "else", "elif", "if", "while", "until"]);
/** 다른 명령을 띄우는 앞말과, 값을 받는 그 옵션. */
const WRAPPERS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-p", "-C", "-h", "-U", "-r", "-t", "-D"], doas: ["-u", "-C"], env: ["-u", "-C", "-S"], nice: ["-n"],
  timeout: ["-s", "-k", "--signal", "--kill-after"], xargs: ["-I", "-n", "-L", "-P", "-s", "-d", "-E", "-a", "-J", "-R", "-S"],
  command: [], builtin: [], exec: ["-a"], nohup: [], time: [], caffeinate: ["-t", "-w"], stdbuf: ["-i", "-o", "-e"], unbuffer: [],
};
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function commandWords(words: string[]): string[] {
  const w = words.slice();
  for (let guard = 0; guard < 20 && w.length; guard++) {
    const head = w[0]!;
    if (KEYWORDS.has(head) || ASSIGN.test(head)) { w.shift(); continue; }
    const name = basename(head), opts = WRAPPERS[name];
    if (!opts) break;
    w.shift();
    while (w.length && w[0]!.startsWith("-")) {
      const o = w.shift()!;
      if (o === "--") break;
      if (opts.includes(o)) w.shift();
    }
    if (name === "env") while (w.length && ASSIGN.test(w[0]!)) w.shift();
    if (name === "timeout" && w.length) w.shift();
  }
  return w;
}

/** -- 앞의 짧은 옵션 묶음에 글자가 있는지(-rf, -fr, -f -r 모두). */
function shortFlag(args: string[], letters: RegExp): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (/^-[A-Za-z]+$/.test(a) && letters.test(a.slice(1))) return true;
  }
  return false;
}
const longFlag = (args: string[], ...names: string[]) => args.some(a => names.some(n => a === n || a.startsWith(`${n}=`)));
const nonOptions = (args: string[]) => args.filter(a => !a.startsWith("-"));

const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
const GH_WRITE: Record<string, string[]> = {
  pr: ["create", "merge", "comment", "review", "close", "edit", "reopen", "ready"],
  issue: ["create", "comment", "close", "edit", "delete", "reopen", "transfer", "lock", "unlock", "pin", "unpin"],
  release: ["create", "delete", "edit", "upload", "delete-asset"],
  repo: ["create", "delete", "edit", "rename", "archive", "unarchive", "fork", "sync"],
  gist: ["create", "edit", "delete"],
};

type Hit = { kind: "delete" | "publish"; what: string };

function riskyCommand(name: string, args: string[], analyze: (words: string[]) => void): Hit | null {
  if (name === "rm") return shortFlag(args, /[rR]/) || longFlag(args, "--recursive") ? { kind: "delete", what: "폴더째 지우기(rm -r)" } : null;
  if (name === "find") {
    if (args.includes("-delete")) return { kind: "delete", what: "find -delete" };
    if (args.some((a, i) => ["-exec", "-execdir", "-ok", "-okdir"].includes(a) && basename(args[i + 1] ?? "") === "rm")) return { kind: "delete", what: "find -exec rm" };
    args.forEach((a, i) => {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(a)) return;
      const end = args.findIndex((b, j) => j > i && (b === ";" || b === "+"));
      analyze(args.slice(i + 1, end < 0 ? undefined : end));
    });
    return null;
  }
  if (name === "git") {
    let i = 0;
    while (i < args.length && args[i]!.startsWith("-")) i += GIT_VALUE_OPTS.has(args[i]!) ? 2 : 1;
    const sub = args[i], rest = args.slice(i + 1);
    if (sub === "push") return { kind: "publish", what: "깃허브에 올리기(git push)" };
    if (sub === "clean" && (shortFlag(rest, /f/) || longFlag(rest, "--force"))) return { kind: "delete", what: "git clean -f" };
    if (sub === "reset" && longFlag(rest, "--hard")) return { kind: "delete", what: "git reset --hard" };
    if (sub === "worktree" && rest[0] === "remove") return { kind: "delete", what: "워크트리 지우기" };
    if (sub === "branch" && (shortFlag(rest, /D/) || ((shortFlag(rest, /d/) || longFlag(rest, "--delete")) && (shortFlag(rest, /f/) || longFlag(rest, "--force"))))) return { kind: "delete", what: "브랜치 강제 지우기" };
    if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) return { kind: "delete", what: "git stash drop/clear" };
    if (sub === "restore") {
      const staged = shortFlag(rest, /S/) || longFlag(rest, "--staged"), worktree = shortFlag(rest, /W/) || longFlag(rest, "--worktree");
      return staged && !worktree ? null : { kind: "delete", what: "작업 중 변경 버리기(git restore)" };
    }
    if (sub === "checkout") {
      const dash = rest.indexOf("--");
      return (dash >= 0 && dash < rest.length - 1) || rest.includes(".") || shortFlag(rest, /f/) || longFlag(rest, "--force") ? { kind: "delete", what: "작업 중 변경 버리기(git checkout --)" } : null;
    }
    if (sub === "switch" && (longFlag(rest, "--discard-changes", "--force") || shortFlag(rest, /f/))) return { kind: "delete", what: "작업 중 변경 버리기(git switch --discard-changes)" };
    return null;
  }
  if (name === "gh") {
    const [group, action] = args;
    if (group && action && GH_WRITE[group]?.includes(action)) return { kind: "publish", what: `깃허브 게시(gh ${group} ${action})` };
    if (group === "api") {
      let method: string | null = null;
      args.forEach((a, i) => {
        if (a === "-X" || a === "--method") method = args[i + 1] ?? null;
        else if (a.startsWith("--method=")) method = a.slice(9);
        else if (/^-X[A-Za-z]+$/.test(a)) method = a.slice(2);
      });
      const fields = args.some(a => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF].+/.test(a));
      const m = (method as string | null)?.toUpperCase() ?? (fields ? "POST" : "GET");
      return m === "GET" || m === "HEAD" ? null : { kind: "publish", what: `깃허브 쓰기 요청(gh api ${m})` };
    }
    return null;
  }
  if (["npm", "bun", "pnpm", "yarn"].includes(name)) {
    const subs = nonOptions(args);
    return subs.slice(0, 3).includes("publish") ? { kind: "publish", what: "패키지 공개(publish)" } : null;
  }
  return null;
}

const TRAVERSE_ALWAYS = new Set(["rg", "ag", "ack", "fd", "find", "tree", "du", "tar", "zip", "rsync", "scp", "ditto", "7z"]);
const GREPS = new Set(["grep", "egrep", "fgrep", "zgrep"]);
/** 폴더를 통째로 지나는 명령(검색·목록·복사·묶기)인지. */
function traverses(name: string, args: string[]): boolean {
  if (TRAVERSE_ALWAYS.has(name)) return true;
  if (GREPS.has(name)) return shortFlag(args, /[rR]/) || longFlag(args, "--recursive", "--dereference-recursive") || args.some((a, i) => (a === "-d" && args[i + 1] === "recurse") || a === "--directories=recurse");
  if (name === "cp") return shortFlag(args, /[rRa]/) || longFlag(args, "--recursive", "--archive");
  if (name === "ls" || name === "chmod" || name === "chown") return shortFlag(args, /R/);
  return false;
}

type Finding = { decision: "deny" | "ask"; reason: string };

const secretReason = (what: string) => `IAMCEO 하네스: 비밀 파일·폴더(${what})는 읽거나 바꾸지 않습니다. 꼭 필요하면 ask 로 대표에게 물으세요`;
const sweepReason = (what: string) => `IAMCEO 하네스: ${what} 는 비밀 폴더를 품고 있어 통째로 검색·복사하지 않습니다. 범위를 좁히거나 꼭 필요하면 ask 로 대표에게 물으세요`;

function shortName(path: string, ctx: GuardContext): string {
  const home = ctx.userHome ?? homedir();
  return inside(path, home) ? `~${path.slice(home.length)}` : path;
}

function analyzeShell(src: string, cwd0: string, ctx: GuardContext, roots: Roots, depth: number, out: Finding[]): void {
  if (depth > 5) return;
  const home = ctx.userHome ?? homedir();
  const { commands, nested } = parseShell(src, home);
  let cwd = cwd0;
  const pathOf = (word: string) => resolve(cwd, word.replace(/^~(?=\/|$)/, home));
  const checkWord = (word: string) => {
    if (!word || word.includes("…")) return;
    const candidates = [word];
    const eq = word.indexOf("=");
    if (eq > 0) candidates.push(word.slice(eq + 1));
    // sqlite 같은 'file:/경로?mode=ro' 주소도 경로로 본다.
    for (const c of [...candidates]) { const uri = /^file:(?:\/\/)?(\/[^?#]*)/.exec(c); if (uri) candidates.push(uri[1]!); }
    for (const w of candidates) {
      if (!w) continue;
      const full = pathOf(w);
      if (hasGlob(w) ? globTouches(full, roots) === "inside" : isSecretPath(full, roots)) out.push({ decision: "deny", reason: secretReason(shortName(full, ctx)) });
    }
  };
  const analyzeWords = (raw: string[], cmd?: SimpleCommand) => {
    for (const w of raw) checkWord(w);
    for (const r of cmd?.redirects ?? []) checkWord(r);
    const words = commandWords(raw);
    if (!words.length) return;
    const name = basename(words[0]!), args = words.slice(1);
    if (name === "security" && ["find-generic-password", "find-internet-password", "dump-keychain", "export"].includes(args[0] ?? "")) out.push({ decision: "deny", reason: secretReason("키체인") });
    if (name === "cd" || name === "pushd") { cwd = args[0] ? pathOf(args[0]) : home; return; }
    if (SHELLS.has(name)) {
      const flags = args.filter(a => /^-[A-Za-z]+$/.test(a));
      const code = args.find(a => !a.startsWith("-"));
      if (flags.some(f => f.includes("c")) && code !== undefined) analyzeShell(code, cwd, ctx, roots, depth + 1, out);
      else if (code === undefined) for (const body of cmd?.heredocs ?? []) analyzeShell(body, cwd, ctx, roots, depth + 1, out);
    }
    if (name === "eval") analyzeShell(args.join(" "), cwd, ctx, roots, depth + 1, out);
    const hit = riskyCommand(name, args, inner => analyzeWords(inner));
    if (hit) out.push({ decision: "ask", reason: hit.kind === "delete" ? `IAMCEO 하네스: ${hit.what}는 되돌리기 어렵습니다. 대표 승인 창으로 넘깁니다. 임시 폴더·기존 변경은 지우지 않습니다` : `IAMCEO 하네스: ${hit.what}는 밖으로 나가는 일입니다. 대표 승인 창으로 넘깁니다` });
    if (traverses(name, args)) {
      const targets = nonOptions(args);
      for (const t of targets.length > (GREPS.has(name) || ["rg", "ag", "ack"].includes(name) ? 1 : 0) ? targets : [...targets, "."]) {
        const full = pathOf(t);
        if (hasGlob(t) ? globTouches(full, roots) !== null : holdsSecret(full, roots)) out.push({ decision: "deny", reason: sweepReason(shortName(full, ctx)) });
      }
    }
  };
  for (const cmd of commands) analyzeWords(cmd.words, cmd);
  for (const code of nested) analyzeShell(code, cwd, ctx, roots, depth + 1, out);
}

const PATH_KEYS = ["file_path", "path", "notebook_path"] as const;

export function guardDecision(input: GuardInput, ctx: GuardContext): GuardDecision {
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const args = input.tool_input && typeof input.tool_input === "object" ? input.tool_input as Record<string, unknown> : {};
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const home = ctx.userHome ?? homedir();
  const roots = secretRoots(ctx);
  const out: Finding[] = [];
  if (tool === "Bash") {
    analyzeShell(typeof args.command === "string" ? args.command : "", cwd, ctx, roots, 0, out);
  } else {
    const full = (v: string, base = cwd) => resolve(base, v.replace(/^~(?=\/|$)/, home));
    for (const key of PATH_KEYS) {
      const value = args[key];
      if (typeof value !== "string" || !value) continue;
      const path = full(value);
      if (isSecretPath(path, roots)) out.push({ decision: "deny", reason: secretReason(value) });
    }
    if (tool === "Grep" || tool === "Glob") {
      const base = typeof args.path === "string" && args.path ? full(args.path) : cwd;
      if (tool === "Grep" && holdsSecret(base, roots)) out.push({ decision: "deny", reason: sweepReason(shortName(base, ctx)) });
      const pattern = tool === "Glob" ? args.pattern : args.glob;
      if (typeof pattern === "string" && pattern) {
        const reach = globTouches(full(pattern, base), roots);
        if (reach === "inside" || (reach === "above" && tool === "Grep")) out.push({ decision: "deny", reason: secretReason(pattern) });
        // 이름만 보는 Grep glob(예: *.json)은 어느 깊이에서나 맞는다. 비밀 폴더를 품은 곳의 Grep 은 위에서 이미 막았다.
      }
    }
  }
  const denied = out.find(f => f.decision === "deny");
  if (denied) return denied;
  const asked = out.find(f => f.decision === "ask");
  return asked ?? { decision: "allow" };
}

/** Claude Code PreToolUse 훅 출력. 허용이면 아무것도 내지 않는다(다른 권한 판정을 그대로 둔다). */
export function hookOutput(decision: GuardDecision): string | null {
  if (decision.decision === "allow") return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.decision, permissionDecisionReason: decision.reason } });
}
