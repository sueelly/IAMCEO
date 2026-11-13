// 완료 검사의 실행 증거. 직원 세션의 제공자 기록(Claude 세션 기록·Codex rollout)을 읽기만 한다.
// 서버가 실행을 지어내지 않고, 기록에 남은 명령·종료 코드·출력만 본다. 기록 형식을 모르는 제공자(Antigravity)는 '지원 안 함'이다.
import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { commandChain } from "./harness-guard.ts";
import type { CliProvider } from "../shared/types.ts";
import { jsonObject, providerLogPath } from "./runner/delivery-evidence.ts";
import { CHECK_LABEL, type CheckKind, type ReportCheckInput, type TaskContract } from "./harness.ts";

/** 실행으로 증명해야 하는 검사. real(화면·캡처)·조사 검사는 명령이 아니라 자료·출처로 본다. */
export const EXEC_CHECKS: ReadonlySet<CheckKind> = new Set<CheckKind>(["behavior", "typecheck", "regression"]);

export interface ExecRecord {
  /** 제공자 안에서 한 번뿐인 실행 표지(Claude tool_use id, Codex item id). 한 실행은 한 업무의 증거로만 쓴다. */
  ref: string;
  command: string;
  /** null: 종료 코드를 알 수 없음(중단·백그라운드·훅 거절 등). 통과 증거가 아니다. */
  exitCode: number | null;
  at: string;
  outputSha: string;
  outputHead: string;
}

/** 직원이 본 도구 결과 글. 조사 인용을 대조한다. input 은 그 도구를 부른 인자(출처 주소·경로가 들어 있다). */
export interface ToolText { tool: string; input: string; text: string; at: string }

export interface ProviderEvidence {
  status: "ok" | "unsupported" | "missing";
  code: string;
  execs: ExecRecord[];
  texts: ToolText[];
}

const MAX_LOG_BYTES = 192 * 1024 * 1024;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const time = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null;
export const normalizeCommand = (text: string) => text.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();
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
  const calls = new Map<string, { name: string; input: Record<string, unknown>; at: string }>();
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
        if (item?.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string") calls.set(item.id, { name: item.name, input: jsonObject(item.input) ?? {}, at: at ?? "" });
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
      texts.push({ tool: call.name, input: JSON.stringify(call.input), text: out, at });
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
      execs.push({ ref: `claude:${item.tool_use_id}`, command: normalizeCommand(call.input.command), exitCode, at, outputSha: sha(output), outputHead: head(output) });
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
      execs.push({ ref: `codex:${typeof payload!.thread_id === "string" ? payload!.thread_id : "?"}:${item.id}`, command: normalizeCommand(command), exitCode, at, outputSha: sha(output), outputHead: head(output) });
    } else if (item.type === "McpToolCall") {
      const result = jsonObject(item.result);
      texts.push({ tool: `${String(item.server ?? "")}/${String(item.tool ?? "")}`, input: JSON.stringify(item.arguments ?? {}), text: contentText(result?.content), at });
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
export function matchExecChecks(checks: ReportCheckInput[], evidence: ProviderEvidence, usedElsewhere: (ref: string) => string | null): { reasons: string[]; results: CheckEvidence[] } {
  const reasons: string[] = [];
  const results: CheckEvidence[] = [];
  checks.forEach((c, idx) => {
    if (!EXEC_CHECKS.has(c.kind) || c.result !== "pass") { results.push({ idx, status: "not_required", ref: null, exitCode: null, at: null, outputSha: null, command: null }); return; }
    if (evidence.status === "unsupported") { results.push({ idx, status: "unsupported", ref: null, exitCode: null, at: null, outputSha: null, command: c.command ?? null }); return; }
    const label = `'${c.name}'(${CHECK_LABEL[c.kind]})`;
    const want = c.command ? normalizeCommand(c.command) : "";
    if (want.length < 3) { reasons.push(`${label}에 실제로 돌린 명령(command)이 없습니다. 실행 기록과 대조할 명령을 적으세요`); return; }
    if (evidence.status === "missing") { reasons.push(`${label}을 대조할 세션 실행 기록을 찾지 못했습니다(${evidence.code}). 증거 없는 통과는 받지 않습니다. 막힘으로 올리고 unverified 에 적으세요`); return; }
    const runs = evidence.execs.map(e => ({ e, proof: execProves(e.command, want) })).filter(r => r.proof !== "absent");
    const last = runs[runs.length - 1];
    if (!last) { reasons.push(`${label}의 명령 '${want.slice(0, 80)}'을 계약 뒤 실행 기록에서 찾지 못했습니다(명령 자리에서 찾습니다. echo 안의 글은 치지 않습니다). 지금 판 기준으로 실제로 돌린 뒤 올리세요`); return; }
    if (last.proof === "masked") { reasons.push(`${label}의 마지막 실행은 뒤에 붙은 파이프·;·& 명령의 종료 코드라 검사 결과가 아닙니다. 그 명령만(또는 &&로, 파이프면 set -o pipefail 로) 다시 돌리세요`); return; }
    if (last.e.exitCode !== 0) { reasons.push(`${label}의 마지막 실행이 통과가 아닙니다(종료 코드 ${last.e.exitCode ?? "알 수 없음"})`); return; }
    const other = usedElsewhere(last.e.ref);
    if (other) { reasons.push(`${label}의 실행은 이미 다른 업무 #${other} 의 증거로 쓰였습니다. 이 업무에서 다시 돌리세요`); return; }
    results.push({ idx, status: "matched", ref: last.e.ref, exitCode: 0, at: last.e.at, outputSha: last.e.outputSha, command: last.e.command });
  });
  return { reasons, results };
}

const startsWith = (words: string[], want: string[]) => words.length >= want.length && want.every((w, i) => i === 0 ? basename(words[0]!) === basename(w) : words[i] === w);

/**
 * 실행한 셸 글이 검사 명령을 증명하는지. 검사 명령의 단순 명령들이 명령 자리에 차례로 있어야 하고(absent),
 * 그 첫 명령부터 끝까지 && 로만 이어져야 종료 코드가 그 명령들의 것이다(masked: | ; || & 가 뒤에 붙음. pipefail 이면 | 는 받음).
 */
export function execProves(executed: string, want: string): "ok" | "absent" | "masked" {
  const wanted = commandChain(want).filter(c => !["cd", "pushd"].includes(basename(c.words[0]!)));
  if (!wanted.length) return "absent";
  const chain = commandChain(executed);
  let at = -1, first = -1;
  for (const w of wanted) {
    const idx = chain.findIndex((c, i) => i > at && startsWith(c.words, w.words));
    if (idx < 0) return "absent";
    if (first < 0) first = idx;
    at = idx;
  }
  const pipefail = /\bpipefail\b/.test(executed);
  for (let i = first; i < chain.length; i++) {
    const sep = chain[i]!.sep;
    if (i === chain.length - 1 ? sep === "" || sep === ";" : sep === "&&" || (sep === "|" && pipefail)) continue;
    return "masked";
  }
  return "ok";
}

export interface ClaimInput {
  text: string;
  basis: "fact" | "interpretation";
  source?: string | null;
  quote?: string | null;
  criterion?: number | null;
}

export interface ClaimResult extends ClaimInput { verified: boolean; via: string | null }

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * 조사 주장 대조. 사실(fact) 주장은 출처와 원문 인용이 있어야 하고, 인용은 직원이 계약 뒤 실제로 본 도구 결과
 * (그 도구 인자에 출처가 들어 있는 것) 또는 이 프로젝트 자료 본문에 그대로 있어야 한다. 해석은 기댄 출처만 적는다.
 * WebFetch 결과는 요약이라 원문이 아닐 수 있다. 그 경우 via 에 '요약에서'로 남긴다.
 */
export function verifyClaims(claims: ClaimInput[], evidence: ProviderEvidence, projectFiles: (source: string) => string | null): { reasons: string[]; results: ClaimResult[] } {
  const reasons: string[] = [];
  const results: ClaimResult[] = claims.map((claim, i) => {
    const label = `주장 ${i + 1}('${claim.text.slice(0, 40)}')`;
    if (claim.basis === "interpretation") {
      if (!claim.source?.trim()) reasons.push(`${label}은 해석인데 기댄 출처(source)가 없습니다`);
      return { ...claim, verified: false, via: null };
    }
    if (!claim.source?.trim() || !claim.quote?.trim()) { reasons.push(`${label}은 사실인데 출처(source)와 원문 인용(quote)이 없습니다`); return { ...claim, verified: false, via: null }; }
    const quote = squash(claim.quote);
    if (quote.length < 8) { reasons.push(`${label}의 인용이 너무 짧습니다(8자 이상의 원문 그대로)`); return { ...claim, verified: false, via: null }; }
    const file = projectFiles(claim.source.trim());
    if (file !== null && squash(file).includes(quote)) return { ...claim, verified: true, via: "자료 본문" };
    const source = claim.source.trim();
    // 인용이 도구 인자에 이미 있으면(echo 등) 본 것이 아니라 쓴 것이다. IAMCEO 도구 결과는 직원 자신의 글이다.
    const hit = evidence.texts.find(t => !/^(mcp__iamceo__|iamceo\/)/.test(t.tool) && t.input.includes(source) && !squash(t.input).includes(quote) && squash(t.text).includes(quote));
    if (hit) return { ...claim, verified: true, via: hit.tool === "WebFetch" ? "WebFetch 요약에서(원문 아님)" : `${hit.tool} 결과` };
    // 기록 형식을 모르는 제공자(Antigravity)는 실행 검사와 같이 '미지원'으로 남긴다(작성자 보고). 개선 후보에 적힌다.
    if (evidence.status === "unsupported") return { ...claim, verified: false, via: "기록 미지원(작성자 보고)" };
    reasons.push(evidence.status === "ok"
      ? `${label}의 인용을 출처 '${source.slice(0, 60)}'를 연 계약 뒤 도구 결과나 자료 본문에서 찾지 못했습니다`
      : `${label}을 대조할 세션 기록이 없습니다(${evidence.code})`);
    return { ...claim, verified: false, via: null };
  });
  return { reasons, results };
}

/** 조사 계약의 완료 조건: 주장이 1개 이상, 사실 주장은 모두 대조됨. */
export function researchGate(contract: TaskContract, claims: ClaimInput[] | undefined): string[] {
  if (contract.kind !== "research" && !contract.checks.includes("source")) return [];
  return claims?.length ? [] : ["조사 업무 완료에는 claims(주장·사실/해석·출처·원문 인용)가 1개 이상 있어야 합니다"];
}
