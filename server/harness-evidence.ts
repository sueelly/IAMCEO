import { publicHarness, redactHarnessText } from "./harness-redaction.ts";
// 완료 검사의 실행 증거. 직원 세션의 제공자 기록(Claude 세션 기록·Codex rollout)을 읽기만 한다.
// 서버가 실행을 지어내지 않고, 기록에 남은 명령·종료 코드·출력만 본다. 기록 형식을 모르는 제공자(Antigravity)는 '지원 안 함'이다.
import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { commandProof } from "./harness-command.ts";
import type { CliProvider } from "../shared/types.ts";
import { jsonObject, providerLogPath } from "./runner/delivery-evidence.ts";
import { CHECK_LABEL, type CheckKind, type ReportCheckInput, type TaskContract } from "./harness.ts";

/** 실행으로 증명해야 하는 검사. real(화면·캡처)·조사 검사는 명령이 아니라 자료·출처로 본다. */
export const EXEC_CHECKS: ReadonlySet<CheckKind> = new Set<CheckKind>(["behavior", "typecheck", "regression"]);

export interface ExecRecord {
  /** 제공자 안에서 한 번뿐인 실행 표지(Claude tool_use id, Codex item id). 한 실행은 한 업무의 증거로만 쓴다. */
  ref: string;
  command: string;
  cwd: string | null;
  /** null: 종료 코드를 알 수 없음(중단·백그라운드·훅 거절 등). 통과 증거가 아니다. */
  exitCode: number | null;
  at: string;
  outputSha: string;
  outputHead: string;
}

/** 직원이 본 도구 결과 글. 조사 인용을 대조한다. input 은 그 도구를 부른 인자(출처 주소·경로가 들어 있다). */
export interface ToolText { tool: string; input: string; text: string; at: string; successful?: boolean }

export interface ProviderEvidence {
  status: "ok" | "unsupported" | "missing";
  code: string;
  execs: ExecRecord[];
  texts: ToolText[];
}

const MAX_LOG_BYTES = 192 * 1024 * 1024;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
export const normalizeCommand = (text: string) => text.trim();
const head = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 160);

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(v => typeof v === "string" ? v : jsonObject(v)?.type === "text" ? String(jsonObject(v)!.text ?? "") : "").filter(Boolean).join("\n");
  return "";
}

/** 기록 파일을 읽기만 한다. 제공자 폴더 밖을 가리키는 링크는 열지 않는다. */
function readLog(root: string, path: string): string | null {
  const target = providerLogPath(root, path);
  if (!target) return null;
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = Math.min(stat.size, MAX_LOG_BYTES);
    const buf = Buffer.alloc(size);
    let read = 0;
    const start = stat.size - size;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString("utf8");
    // 앞을 잘라 읽었으면 첫 줄은 조각이다.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return null; } finally { closeSync(fd); }
}

/** must 중 하나를 품은 줄만 JSON 으로 푼다(100MB 기록도 1초 안에 본다). */
function* records(text: string, must: string[]): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    if (!line.trim() || !must.some(m => line.includes(m))) continue;
    try { const v = jsonObject(JSON.parse(line)); if (v) yield v; } catch { /* 쓰는 중인 마지막 줄 */ }
  }
}

/** Claude 세션 기록: assistant 의 tool_use(Bash input.command) ↔ user 의 tool_result(is_error, "Exit code N"). */
export function parseClaudeLog(text: string, since: string | null): Pick<ProviderEvidence, "execs" | "texts"> {
  const calls = new Map<string, { name: string; input: Record<string, unknown>; at: string; cwd: string | null }>();
  const execs: ExecRecord[] = [];
  const texts: ToolText[] = [];
  const after = since ? Date.parse(since) : -Infinity;
  for (const r of records(text, ['"tool_use"', '"tool_result"'])) {
    const at = time(r.timestamp);
    const message = jsonObject(r.message);
    const content = Array.isArray(message?.content) ? message!.content : [];
    if (r.type === "assistant") {
      for (const c of content) {
        const item = jsonObject(c);
        if (item?.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string") calls.set(item.id, { name: item.name, input: jsonObject(item.input) ?? {}, at: at ?? "", cwd: typeof r.cwd === "string" ? r.cwd : null });
      }
      continue;
    }
    if (r.type !== "user" || !at || Date.parse(at) < after) continue;
    for (const c of content) {
      const item = jsonObject(c);
      if (item?.type !== "tool_result" || typeof item.tool_use_id !== "string") continue;
      const call = calls.get(item.tool_use_id);
      if (!call || (call.at && Date.parse(call.at) < after)) continue;
      const out = contentText(item.content);
      texts.push({ tool: call.name, input: JSON.stringify(call.input), text: out, at, successful: item.is_error !== true });
      if (call.name !== "Bash" || typeof call.input.command !== "string") continue;
      const result = jsonObject(r.toolUseResult);
      let exitCode: number | null = null;
      if (item.is_error === true) {
        const m = /^Exit code (\d+)/.exec(out.trim());
        exitCode = m ? Number(m[1]) : null;
      } else if (result && result.interrupted !== true && !result.backgroundTaskId && typeof result.stdout === "string") {
        exitCode = 0;
      }
      const output = result && typeof result.stdout === "string" ? `${result.stdout}\n${typeof result.stderr === "string" ? result.stderr : ""}` : out;
      execs.push({ ref: `claude:${item.tool_use_id}`, command: call.input.command, cwd: call.cwd, exitCode, at, outputSha: sha(output), outputHead: head(output) });
    }
  }
  return { execs, texts };
}

/** Codex rollout: event_msg item_completed 의 CommandExecution{command, exit_code, status, aggregated_output}. */
export function parseCodexLog(text: string, since: string | null): Pick<ProviderEvidence, "execs" | "texts"> {
  const execs: ExecRecord[] = [];
  const texts: ToolText[] = [];
  const after = since ? Date.parse(since) : -Infinity;
  for (const r of records(text, ['"CommandExecution"', '"McpToolCall"'])) {
    const at = time(r.timestamp);
    if (!at || Date.parse(at) < after || r.type !== "event_msg") continue;
    const payload = jsonObject(r.payload);
    const item = payload?.type === "item_completed" ? jsonObject(payload.item) : null;
    if (!item || typeof item.id !== "string") continue;
    if (item.type === "CommandExecution") {
      const argv = Array.isArray(item.command) ? item.command.map(String) : typeof item.command === "string" ? [item.command] : [];
      // ["/bin/zsh", "-lc", "<스크립트>"] 이면 스크립트가 직원이 부른 명령이다.
      const command = argv.length >= 3 && /^-l?c$/.test(argv[argv.length - 2]!) ? argv[argv.length - 1]! : argv.join(" ");
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      const exitCode = item.status === "completed" || item.status === "failed" ? (Number.isInteger(item.exit_code) ? item.exit_code as number : null) : null;
      texts.push({ tool: "CommandExecution", input: command, text: output, at });
      execs.push({ ref: `codex:${typeof payload!.thread_id === "string" ? payload!.thread_id : "?"}:${item.id}`, command, cwd: typeof item.cwd === "string" ? item.cwd : null, exitCode, at, outputSha: sha(output), outputHead: head(output) });
    } else if (item.type === "McpToolCall") {
      const result = jsonObject(item.result);
      texts.push({ tool: `${String(item.server ?? "")}/${String(item.tool ?? "")}`, input: JSON.stringify(item.arguments ?? {}), text: contentText(result?.content), at, successful: result?.isError !== true });
    }
  }
  return { execs, texts };
}

/** 직원 세션 기록에서 since(계약 시각) 뒤의 실행·도구 결과. 기록을 못 찾으면 missing(통과 증거가 없다). */
export function readProviderEvidence(cli: CliProvider, log: { path: string; home: string; root: string } | null, since: string | null): ProviderEvidence {
  if (cli === "antigravity") return { status: "unsupported", code: "antigravity_exec_format_unknown", execs: [], texts: [] };
  if (!log) return { status: "missing", code: "log_not_found", execs: [], texts: [] };
  if (cli === "claude" && !basename(log.path).endsWith(".jsonl")) return { status: "missing", code: "unrecognized_path", execs: [], texts: [] };
  const text = readLog(log.root, log.path);
  if (text === null) return { status: "missing", code: "log_unreadable", execs: [], texts: [] };
  const parsed = cli === "codex" ? parseCodexLog(text, since) : parseClaudeLog(text, since);
  return { status: "ok", code: "ok", ...parsed };
}

export interface CheckEvidence {
  /** 검사 순번(보고의 checks 안). */
  idx: number;
  status: "matched" | "unsupported" | "not_required";
  ref: string | null;
  exitCode: number | null;
  at: string | null;
  outputSha: string | null;
  command: string | null;
}

/**
 * 실행 검사(behavior·typecheck·regression)의 통과 주장을 기록과 대조한다. 통과마다 command 가 있어야 하고,
 * 계약 시각 뒤 그 명령을 품은 마지막 실행이 종료 코드 0 이어야 한다. 다른 업무에 이미 쓴 실행은 쓰지 않는다.
 */
export function matchExecChecks(checks: ReportCheckInput[], evidence: ProviderEvidence, usedElsewhere: (ref: string) => string | null, expectedCwd: string | null = null): { reasons: string[]; results: CheckEvidence[] } {
  const reasons: string[] = [];
  const results: CheckEvidence[] = [];
  checks.forEach((c, idx) => {
    if (!EXEC_CHECKS.has(c.kind) || c.result !== "pass") { results.push({ idx, status: "not_required", ref: null, exitCode: null, at: null, outputSha: null, command: null }); return; }
    if (evidence.status === "unsupported") { results.push({ idx, status: "unsupported", ref: null, exitCode: null, at: null, outputSha: null, command: c.command ?? null }); return; }
    const label = `'${c.name}'(${CHECK_LABEL[c.kind]})`;
    const want = c.command ? normalizeCommand(c.command) : "";
    if (want.length < 3) { reasons.push(`${label}에 실제로 돌린 명령(command)이 없습니다. 실행 기록과 대조할 명령을 적으세요`); return; }
    if (evidence.status === "missing") { reasons.push(`${label}을 대조할 세션 실행 기록을 찾지 못했습니다(${evidence.code}). 증거 없는 통과는 받지 않습니다. 막힘으로 올리고 unverified 에 적으세요`); return; }
    const runs = evidence.execs.map(e => ({ e, proof: e.cwd === null && expectedCwd !== null ? "absent" as const : execProves(e.command, want, e.cwd ?? null, expectedCwd) })).filter(r => r.proof !== "absent");
    const last = runs[runs.length - 1];
    if (!last) { reasons.push(`${label}의 명령 '${redactHarnessText(want).slice(0, 80)}'을 계약 뒤 실행 기록에서 찾지 못했습니다(명령 자리에서 찾습니다. echo 안의 글은 치지 않습니다). 지금 판 기준으로 실제로 돌린 뒤 올리세요`); return; }
    if (last.proof === "masked") { reasons.push(`${label}의 마지막 실행은 뒤에 붙은 파이프·;·& 명령의 종료 코드라 검사 결과가 아닙니다. 그 명령만(또는 &&로, 파이프면 명시적인 set -o pipefail 로) 다시 돌리세요`); return; }
    if (last.e.exitCode !== 0) { reasons.push(`${label}의 마지막 실행이 통과가 아닙니다(종료 코드 ${last.e.exitCode ?? "알 수 없음"})`); return; }
    const other = usedElsewhere(last.e.ref);
    if (other) { reasons.push(`${label}의 실행은 이미 다른 업무 #${other} 의 증거로 쓰였습니다. 이 업무에서 다시 돌리세요`); return; }
    results.push({ idx, status: "matched", ref: last.e.ref, exitCode: 0, at: last.e.at, outputSha: last.e.outputSha, command: last.e.command });
  });
  return { reasons: reasons.map(redactHarnessText), results: publicHarness(results) };
}

/** 셸의 인자·위치·종료 의미를 보수적으로 대조한다. */
export function execProves(executed: string, want: string, actualCwd: string | null = null, expectedCwd: string | null = actualCwd): "ok" | "absent" | "masked" {
  return commandProof(executed, want, actualCwd, expectedCwd);
}

export interface ClaimInput {
  text: string;
  basis: "fact" | "interpretation";
  source?: string | null;
  quote?: string | null;
  criterion?: number | null;
}

/** verified는 주장 진위/의미 검증이다. 이 계층은 이를 보장하지 않는다. */
export interface ClaimResult extends ClaimInput {
  verified: boolean;
  via: string | null;
  quoteMatched?: boolean;
  sourceRead?: boolean;
  semanticReview?: "required";
}
const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const QUOTE_SCOPE = "인용 존재만 확인: ", READ_SCOPE = "출처 열람만 확인: ";
/** 이전 verified=true도 의미 검증으로 반환하지 않는다. 옛 대조는 새 읽기 검사를 통과한 것으로 승격하지 않는다. */
export function claimObservation(claim: ClaimInput, via: string | null): ClaimResult {
  const quoteMatched = !!via?.startsWith(QUOTE_SCOPE);
  const sourceRead = quoteMatched || !!via?.startsWith(READ_SCOPE);
  if (sourceRead && via && !via.includes("주장 의미는 별도 검토")) via += " (주장 의미는 별도 검토)";
  return { ...claim, verified: false, via: via && !sourceRead ? `이전 또는 미확인 기록(주장 의미는 별도 검토): ${via}` : via,
    quoteMatched, sourceRead, semanticReview: "required" };
}

/** 확인한 읽기 도구의 실제 대상만 출처에 묶는다. 셸/MCP 이름 추측/인자 속 URL은 인정하지 않는다. */
function readsSource(t: ToolText, source: string): boolean {
  if (t.successful === false) return false;
  let input: Record<string, unknown> | null;
  try { input = jsonObject(JSON.parse(t.input)); } catch { return false; }
  if (!input) return false;
  if (t.tool === "WebFetch") {
    try { return new URL(source).protocol.match(/^https?:$/) !== null && typeof input.url === "string" && new URL(input.url).href === new URL(source).href; } catch { return false; }
  }
  return t.tool === "Read" && source.startsWith("/") && input.file_path === source;
}

/** 인용 존재/출처 열람만 검사한다. 주장과 인용의 의미 일치·진위는 별도 검토에 남긴다. */
export function verifyClaims(claims: ClaimInput[], evidence: ProviderEvidence, projectFiles: (source: string) => string | null): { reasons: string[]; results: ClaimResult[] } {
  const reasons: string[] = [];
  const results = claims.map((claim, i) => {
    const label = `주장 ${i + 1}('${claim.text.slice(0, 40)}')`;
    const source = claim.source?.trim();
    const none = () => claimObservation(claim, null);
    if (!source || (claim.basis === "fact" && !claim.quote?.trim())) {
      reasons.push(`${label}에 출처(source)${claim.basis === "fact" ? "와 원문 인용(quote)" : ""}이 없습니다`); return none();
    }
    const quote = squash(claim.quote ?? "");
    if (claim.basis === "fact" && quote.length < 8) { reasons.push(`${label}의 인용이 너무 짧습니다(8자 이상의 원문 그대로)`); return none(); }
    const file = projectFiles(source);
    const hit = evidence.texts.find(t => readsSource(t, source) && (claim.basis !== "fact" || squash(t.text).includes(quote)));
    if (claim.basis === "interpretation" && (file !== null || hit)) return claimObservation(claim, READ_SCOPE + (file !== null ? "자료 본문" : `${hit!.tool} 결과`));
    if (claim.basis === "fact" && file !== null && squash(file).includes(quote)) return claimObservation(claim, QUOTE_SCOPE + "자료 본문");
    if (hit) return claimObservation(claim, QUOTE_SCOPE + (hit.tool === "WebFetch" ? "WebFetch 요약(원문 아님)" : `${hit.tool} 결과`));
    if (evidence.status === "unsupported") return claimObservation(claim, "기록 미지원(작성자 보고)");
    reasons.push(evidence.status === "ok"
      ? `${label}의 ${claim.basis === "fact" ? "인용을" : "근거를"} 출처 '${source.slice(0, 60)}'를 연 계약 뒤 도구 결과나 자료 본문에서 찾지 못했습니다`
      : `${label}을 대조할 세션 기록이 없습니다(${evidence.code})`);
    return none();
  });
  return { reasons: reasons.map(redactHarnessText), results: publicHarness(results) };
}

/** 조사 계약의 완료 조건: 주장이 1개 이상, 사실 주장은 모두 대조됨. */
export function researchGate(contract: TaskContract, claims: ClaimInput[] | undefined): string[] {
  if (contract.kind !== "research" && !contract.checks.includes("source")) return [];
  return claims?.length ? [] : ["조사 업무 완료에는 claims(주장·사실/해석·출처·원문 인용)가 1개 이상 있어야 합니다"];
}
