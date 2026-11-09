// Antigravity CLI (`agy`) support: per-member configuration home, observed screen layouts and transcript records.
// Every layout here was observed on agy 1.5.3 (2026-11-09). Unknown layouts fail closed (null / unknown).
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { ApprovalPrompt } from "../../shared/types.ts";
import { jsonObject } from "./delivery-evidence.ts";

/** Real per-turn effort is part of agy's model id (e.g. gemini-4-argon-medium). */
export const ANTIGRAVITY_DEFAULT_MODELS: { value: string; label: string }[] = [
  ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"], ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"], ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"], ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["claude-opus-5-5-low", "Claude Opus 5.5 (Low)"], ["claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"], ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"],
  ["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"], ["claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"], ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
].map(([value, label]) => ({ value: value!, label: label! }));

/** agy model ids are lowercase slugs (e.g. gemini-4-argon-medium); anything else is never passed to --model. */
export const ANTIGRAVITY_MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,79}$/;
export const ANTIGRAVITY_CONVERSATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** IAMCEO-owned agy configuration root for one member (`agy --gemini_dir=<this>`). Never the user's ~/.gemini. */
export function antigravityMemberHome(root: string, memberId: string): string {
  if (!isAbsolute(root) || !/^[A-Za-z0-9_-]{1,128}$/.test(memberId)) throw new Error("Invalid Antigravity home");
  return join(root, memberId);
}
/** agy keeps its own state under <gemini_dir>/antigravity-cli. */
export function antigravityStateDir(home: string): string { return join(home, "antigravity-cli"); }
export function antigravityTranscriptPath(home: string, conversationId: string): string {
  if (!ANTIGRAVITY_CONVERSATION_RE.test(conversationId)) throw new Error("Invalid Antigravity conversation id");
  return join(antigravityStateDir(home), "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}
/** Root that readJsonlRange/providerLogPath must contain every transcript path in. */
export function antigravityLogRoot(home: string): string { return join(antigravityStateDir(home), "brain"); }
export function isAntigravityTranscript(home: string, path: string): string | null {
  const rel = relative(antigravityLogRoot(home), path).split(/[\\/]/);
  return rel.length === 4 && ANTIGRAVITY_CONVERSATION_RE.test(rel[0]!) && rel[1] === ".system_generated" && rel[2] === "logs" && rel[3] === "transcript.jsonl" ? rel[0]! : null;
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let same = false;
  try { same = readFileSync(path, "utf8") === content; } catch { /* new */ }
  if (!same) {
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    try { writeFileSync(tmp, content, { mode: 0o600 }); renameSync(tmp, path); }
    finally { try { unlinkSync(tmp); } catch { /* renamed */ } }
  }
  chmodSync(path, 0o600);
}
function readJson(path: string): Record<string, unknown> | null {
  try { return jsonObject(JSON.parse(readFileSync(path, "utf8"))); } catch { return null; }
}

export interface AntigravityHomeInput {
  home: string;
  systemPrompt: string;
  bridge: { command: string; args: string[]; env: Record<string, string> };
  /** The user's own agy root (default ~/.gemini). Read only. */
  userRoot?: string;
}
/**
 * Writes the member's agy root before each launch. The user's global rules, MCP servers, display settings, trust
 * decisions and finished onboarding are copied in (read only), so the member does not re-ask what the owner already
 * answered — including the Terms/data-use screen, which IAMCEO never answers on the owner's behalf.
 */
export function prepareAntigravityHome(input: AntigravityHomeInput): void {
  const { home } = input;
  const user = input.userRoot ?? join(homedir(), ".gemini");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  let rules = input.systemPrompt.trimEnd() + "\n";
  try {
    const own = readFileSync(join(user, "GEMINI.md"), "utf8").trim();
    if (own) rules += `\n\n# 사용자 전역 규칙 (~/.gemini/GEMINI.md)\n\n${own}\n`;
  } catch { /* none */ }
  writePrivate(join(home, "GEMINI.md"), rules);
  const userServers = jsonObject(readJson(join(user, "config", "mcp_config.json"))?.mcpServers) ?? {};
  const servers = { ...userServers, iamceo: { command: input.bridge.command, args: input.bridge.args, env: input.bridge.env } };
  writePrivate(join(home, "config", "mcp_config.json"), JSON.stringify({ mcpServers: servers }, null, 2));
  const state = antigravityStateDir(home);
  const userSettings = readJson(join(user, "antigravity-cli", "settings.json")) ?? {};
  const own = readJson(join(state, "settings.json")) ?? {};
  const trusted = [...new Set([userSettings.trustedWorkspaces, own.trustedWorkspaces].flatMap((list) => Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []))];
  // Only display/behaviour keys the owner chose. Account, model and permission keys stay out: IAMCEO sets those per launch.
  const copied = Object.fromEntries(["colorScheme", "altScreenMode", "editorMode", "verbosity", "showTips", "useTerminalCursor", "allowNonWorkspaceAccess", "enableTerminalSandbox", "useG1Credits"]
    .filter((key) => userSettings[key] !== undefined).map((key) => [key, userSettings[key]]));
  writePrivate(join(state, "settings.json"), JSON.stringify({ ...own, ...copied, showFeedbackSurvey: false, ...(trusted.length ? { trustedWorkspaces: trusted } : {}) }, null, 2));
  const onboarding = join(state, "cache", "onboarding.json");
  const userOnboarding = readJson(join(user, "antigravity-cli", "cache", "onboarding.json"));
  if (!existsSync(onboarding) && userOnboarding?.onboardingComplete === true) writePrivate(onboarding, JSON.stringify(userOnboarding, null, 2));
}

/** True when the owner has finished agy's first-run setup in their own ~/.gemini. */
export function antigravityOnboarded(userRoot = join(homedir(), ".gemini")): boolean {
  return readJson(join(userRoot, "antigravity-cli", "cache", "onboarding.json"))?.onboardingComplete === true;
}

/** The conversation agy last opened for this cwd in this member home, if any. A candidate only — verify by transcript. */
export function lastAntigravityConversation(home: string, cwd: string): string | null {
  const id = readJson(join(antigravityStateDir(home), "cache", "last_conversations.json"))?.[cwd];
  return typeof id === "string" && ANTIGRAVITY_CONVERSATION_RE.test(id) ? id : null;
}

const strip = (screen: string) => screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const RULE = /^[─━]{3,}\s*$/;
/** Footer rows observed under the composer: idle hint, working hint, then the right-aligned "<model> · <effort>". */
const FOOTER = /^\s*(?:(?:\? for shortcuts|esc to cancel)(?:\s{2,}.*)?|\S.* · (?:low|medium|high|xhigh|max|minimal))\s*$/i;

function composer(screen: string): { lines: string[] } | null {
  const lines = strip(screen).split("\n").map((line) => line.replace(/\s+$/, ""));
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  let bottom = end - 1;
  while (bottom >= 0 && !RULE.test(lines[bottom]!)) bottom--;
  if (bottom < 1) return null;
  const footer = lines.slice(bottom + 1, end).filter((line) => line.trim());
  if (!footer.length || footer.some((line) => !FOOTER.test(line))) return null;
  let top = bottom - 1;
  while (top >= 0 && !RULE.test(lines[top]!)) top--;
  if (top < 0 || bottom - top < 2) return null;
  const body = lines.slice(top + 1, bottom);
  if (!/^>(?: |$)/.test(body[0]!)) return null;
  return { lines: body };
}
/** Input safety only: "" empty, text = someone's draft, null = cannot identify the composer (refuse input). */
export function antigravityDraft(screen: string): string | null {
  const box = composer(screen);
  if (!box) return null;
  return [box.lines[0]!.replace(/^> ?/, ""), ...box.lines.slice(1)].join("\n").trim();
}
/** Exact composer text for a submit-only comparison. No trimming inside the text. */
export function antigravityExactComposer(screen: string): string | null {
  const box = composer(screen);
  if (!box || box.lines.length !== 1) return null;
  return box.lines[0]!.replace(/^> ?/, "");
}

/** Observed agy 1.5.3 workspace trust dialog; only an explicit owner answer sends keys. */
export function antigravityFolderTrust(screen: string, cwd: string): { prompt: ApprovalPrompt; selected: number } | null {
  if (screen.includes("\x1b") || !cwd.startsWith("/") || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(cwd)) return null;
  // agy separates every block with a blank line; blank lines carry no meaning here.
  const lines = screen.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.lastIndexOf("Accessing workspace:");
  if (heading < 0 || lines[heading + 1] !== cwd || lines[heading + 2] !== "Do you trust the contents of this project?" ||
      lines[heading + 3] !== "Antigravity CLI requires permission to read, edit, and execute files here.") return null;
  const options = [lines[heading + 4], lines[heading + 5]].map((line) => /^(>\s*)?(Yes, I trust this folder|No, exit)$/.exec(line ?? ""));
  if (!options[0] || !options[1] || options[0][2] !== "Yes, I trust this folder" || options[1][2] !== "No, exit" || (!!options[0][1]) === (!!options[1][1])) return null;
  const rest = lines.slice(heading + 6);
  if (rest[0] !== "↑/↓ Navigate · enter Confirm" || rest.slice(1).some((line) => !FOOTER.test(line))) return null;
  return { selected: options[0][1] ? 0 : 1, prompt: {
    title: "폴더 신뢰 확인", body: `${cwd}\nAntigravity가 이 폴더의 파일을 읽고 고치고 실행할 수 있게 됩니다`, question: "Do you trust the contents of this project?",
    options: [{ n: 1, label: "Yes, I trust this folder", reject: false }, { n: 2, label: "No, exit", reject: true }],
    fingerprint: createHash("sha256").update(screen).digest("hex").slice(0, 24),
  } };
}

export interface AntigravityUserInput { text: string; createdAt: string | null; stepIndex: number | null }
/** transcript.jsonl USER_INPUT records only (USER_EXPLICIT). Tool output and model text are never user input. */
export function parseAntigravityUserInput(value: unknown): AntigravityUserInput | null {
  const entry = jsonObject(value);
  if (!entry || entry.type !== "USER_INPUT" || typeof entry.content !== "string") return null;
  if (entry.source !== undefined && entry.source !== "USER_EXPLICIT") return null;
  return { text: entry.content, createdAt: typeof entry.created_at === "string" ? entry.created_at : null, stepIndex: typeof entry.step_index === "number" ? entry.step_index : null };
}
/** Known record kinds. Anything else is unsupported only if it could be user input or carries a marker. */
export const ANTIGRAVITY_RECORD_TYPES = ["USER_INPUT", "PLANNER_RESPONSE", "SYSTEM_MESSAGE", "GENERIC"];
export function supportedAntigravityRecord(value: unknown): boolean {
  const entry = jsonObject(value);
  if (!entry || typeof entry.type !== "string") return false;
  if (entry.type === "USER_INPUT") return typeof entry.content === "string";
  return true;
}
/** Last model response's prompt size (input + cache read), the same sum the status line reports. */
export function antigravityContextTokens(values: unknown[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const entry = jsonObject(values[i]);
    if (entry?.source !== "MODEL" || typeof entry.input_tokens !== "number") continue;
    const parts = [entry.input_tokens, entry.cache_read_tokens ?? 0];
    return parts.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ? (parts as number[]).reduce((a, b) => a + b, 0) : null;
  }
  return null;
}
export const conversationOf = (path: string) => basename(dirname(dirname(dirname(path))));

const MAX_SCAN_BYTES = 4 * 1024 * 1024;
/** Reads at most `limit` bytes from the start or end of a regular, non-symlink file. */
function readBounded(path: string, from: "head" | "tail", limit = MAX_SCAN_BYTES): string | null {
  let fd: number | null = null;
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, limit);
    const start = from === "head" ? 0 : size - length;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    // A partial first/last line is never parsed.
    if (from === "tail" && start > 0) text = text.slice(text.indexOf("\n") + 1);
    if (from === "head" && length < size) text = text.slice(0, text.lastIndexOf("\n") + 1);
    return text;
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch {} }
}
const jsonLines = (text: string): unknown[] => text.split("\n").flatMap((line) => { if (!line.trim()) return []; try { return [JSON.parse(line)]; } catch { return []; } });

export interface AntigravityBindingResult { outcome: "bound" | "pending" | "ambiguous"; sessionId: string | null }
/** Finds the one conversation in this member home whose user input carries the binding marker sent after `since`.
 * Candidates: every brain/<uuid>/ transcript (the member home is IAMCEO-owned and holds only this member's conversations). */
export function discoverAntigravityConversation(input: { home: string; nonce: string; since: string; marker: string }): AntigravityBindingResult {
  const sinceMs = Date.parse(input.since);
  // transcript created_at has whole-second precision.
  const floor = Number.isFinite(sinceMs) ? sinceMs - 2000 : 0;
  let names: string[] = [];
  try { names = readdirSync(antigravityLogRoot(input.home)).filter((name) => ANTIGRAVITY_CONVERSATION_RE.test(name)); } catch { return { outcome: "pending", sessionId: null }; }
  const found: string[] = [];
  for (const id of names) {
    const path = antigravityTranscriptPath(input.home, id);
    try { if (lstatSync(path).mtimeMs < floor) continue; } catch { continue; }
    const text = readBounded(path, "head");
    if (!text || !text.includes(input.nonce)) continue;
    const hit = jsonLines(text).some((value) => {
      const user = parseAntigravityUserInput(value);
      if (!user || !user.text.includes(input.marker)) return false;
      const at = user.createdAt ? Date.parse(user.createdAt) : NaN;
      return Number.isFinite(at) && at >= floor;
    });
    if (hit) found.push(id);
  }
  if (found.length === 1) return { outcome: "bound", sessionId: found[0]! };
  return { outcome: found.length ? "ambiguous" : "pending", sessionId: null };
}
/** Prompt tokens of the latest model step in a transcript under this home, or null. */
export function readAntigravityContext(home: string, path: string): number | null {
  if (!isAntigravityTranscript(home, path)) return null;
  const text = readBounded(path, "tail");
  return text ? antigravityContextTokens(jsonLines(text)) : null;
}
/** Existing transcript path for a conversation, or null. */
export function existingAntigravityTranscript(home: string, conversationId: string): string | null {
  if (!ANTIGRAVITY_CONVERSATION_RE.test(conversationId)) return null;
  const path = antigravityTranscriptPath(home, conversationId);
  try { return lstatSync(path).isFile() ? path : null; } catch { return null; }
}
