// 보호된 기록 읽기 안에서 만드는 진단 메타데이터. 원시 값·본문·출력은 반환하지 않는다.
import { createHash } from "node:crypto";
import { jsonObject } from "./runner/delivery-evidence.ts";
import { commandObservation } from "./harness-command.ts";
import type { ExecRecord } from "./harness-evidence.ts";
import { codexWorkdir } from "./harness-workdir.ts";

export interface LogSelectionObservation {
  code: "selected" | "provider_homes_missing" | "session_missing" | "no_matching_session" | "cwd_mismatch" | "ambiguous" | "lookup_failed" | "unsupported";
  registeredSession: boolean;
  source: "claude_session_filename" | "codex_session_meta" | "unsupported";
  sessionMatch: boolean | null;
  cwdMatch: boolean | null;
  matchingFiles: number;
  metadataReadLimitBytes: number | null;
}
export interface EvidenceReadRange {
  limitBytes: number; gateLimitBytes: number; fileBytes: number; bytesRead: number;
  startOffset: number; endOffset: number; headTruncated: boolean; leadingFragmentDiscarded: boolean;
  stable: boolean; bytesComplete: boolean;
  wholeWindowFragment?: boolean;
}
type Row = Record<string, unknown>;
type NumericObservation = { status: "absent" | "consistent" | "conflict" | "invalid"; fieldCount: number; invalidCount: number; hasConflict: boolean };
type Candidate = {
  origin: { line: number; item: number };
  rawRef: string; format: "claude_bash" | "codex_command_execution" | "codex_function_call" | "codex_exec_event";
  command: string; cwd: string | null; callAt: string | null; resultAt: string | null;
  callObserved: boolean; startObserved: boolean; resultObserved: boolean; combined: boolean; parserSupported: boolean;
  pairAmbiguous: boolean; duplicateReference: boolean;
  relatedToTarget: boolean;
  completion: "completed" | "failed" | "in_progress" | "returned" | "unknown";
  numericExit: number | null;
  numericObservation: NumericObservation;
};
const instant = (v: unknown): string | null => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null;
const text = (v: unknown) => typeof v === "string" ? v : null;
const numeric = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 255 ? v as number : null;
function observeNumeric(...sources: (Row | null | undefined)[]) {
  const fields = sources.flatMap(s => s ? ["exitCode", "exit_code"].filter(k => Object.hasOwn(s, k)).map(k => s[k]) : []);
  const valid = fields.map(numeric), invalidCount = valid.filter(n => n === null).length;
  const hasConflict = new Set(valid.filter(n => n !== null)).size > 1;
  const status: NumericObservation["status"] = !fields.length ? "absent" : invalidCount ? "invalid" : hasConflict ? "conflict" : "consistent";
  return { numericExit: status === "consistent" ? valid[0]! : null, numericObservation: { status, fieldCount: fields.length, invalidCount, hasConflict } };
}
const state = (v: unknown): Candidate["completion"] => v === "completed" || v === "failed" || v === "in_progress" ? v : "unknown";
const fingerprint = (v: string) => createHash("sha256").update("exec-diagnostic\0" + v).digest("hex").slice(0, 24);
function codexCommand(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (!Array.isArray(v) || !v.every(x => typeof x === "string")) return null;
  return v.length >= 3 && /^-l?c$/.test(v[v.length - 2]) ? v[v.length - 1] : v.join(" ");
}

/** 알 수 없는 이름/상태/식별자는 고정 범주나 지문으로 바꾼다. 증거 채택은 기존 파서·matchExecChecks 결과만 쓴다. */
export function observeExecWindow(input: { cli: "codex" | "claude"; text: string; range: EvidenceReadRange; all: ExecRecord[]; current: ExecRecord[];
  command: string; cwd: string; since: string; commandRedacted: boolean; matched: boolean }) {
  const candidates = new Map<string, Candidate>(), resultKeys = new Set<string>(), kinds: Record<string, number> = {};
  let invalidLines = 0;
  const originKey = (origin: ExecRecord["origin"]) => origin ? `${origin.line}:${origin.item}` : "";
  const parsed = new Map(input.all.filter(e => e.origin).map(e => [originKey(e.origin), e]));
  const current = new Map(input.current.filter(e => e.origin).map(e => [originKey(e.origin), e]));
  const referenceCounts = new Map<string, number>(), duplicateReferences = new Set<string>();
  const observeReference = (key: string, role: "call" | "result") => {
    const part = `${key}\0${role}`, n = (referenceCounts.get(part) ?? 0) + 1;
    referenceCounts.set(part, n); if (n > 1) duplicateReferences.add(key);
  };
  const count = (kind: string) => { kinds[kind] = (kinds[kind] ?? 0) + 1; };
  const isRelated = (command: string, cwd: string | null) => {
    const proof = commandObservation(command, input.command, cwd, input.cwd);
    return proof.commandMatch === true || proof.sameExecutable;
  };
  let lineIndex = -1;
  const fresh = (rawRef: string, format: Candidate["format"], command: string, cwd: string | null, at: string | null, callObserved = true): Candidate =>
    ({ origin: { line: lineIndex, item: 0 }, rawRef, format, command, cwd, callAt: callObserved ? at : null, resultAt: null, callObserved, startObserved: callObserved, resultObserved: false, combined: false, parserSupported: false,
      pairAmbiguous: false, duplicateReference: false, relatedToTarget: isRelated(command, cwd), completion: "unknown", ...observeNumeric() });
  for (const line of input.text.split("\n")) {
    lineIndex++;
    if (!line.trim()) continue;
    let r: Row | null;
    try { r = jsonObject(JSON.parse(line)); } catch { invalidLines++; continue; }
    if (!r) { invalidLines++; continue; }
    const at = instant(r.timestamp);
    if (input.cli === "claude") {
      count(r.type === "assistant" ? "claude_assistant" : r.type === "user" ? "claude_user" : "other");
      const message = jsonObject(r.message), content = Array.isArray(message?.content) ? message.content : [];
      for (const [itemIndex, c] of content.entries()) {
        const item = jsonObject(c); if (!item) continue;
        if (r.type === "assistant" && item.type === "tool_use" && typeof item.id === "string") observeReference(`claude:${item.id}`, "call");
        if (r.type === "assistant" && item.type === "tool_use" && item.name === "Bash" && typeof item.id === "string") {
          const args = jsonObject(item.input); if (typeof args?.command !== "string") continue;
          const key = `claude:${item.id}`;
          const candidate = { ...fresh(key, "claude_bash", args.command, text(r.cwd), at), origin: { line: lineIndex, item: itemIndex }, parserSupported: true, pairAmbiguous: resultKeys.has(key) };
          candidate.relatedToTarget ||= candidates.get(key)?.relatedToTarget ?? false;
          candidates.set(key, candidate);
        }
        if (r.type === "user" && item.type === "tool_result" && typeof item.tool_use_id === "string") {
          const key = `claude:${item.tool_use_id}`; resultKeys.add(key); observeReference(key, "result");
          const c = candidates.get(key); if (!c) continue;
          c.origin = { line: lineIndex, item: itemIndex };
          c.resultObserved = true; c.resultAt = at;
          const result = jsonObject(r.toolUseResult);
          Object.assign(c, observeNumeric(item, result));
          c.completion = result?.interrupted === true || result?.backgroundTaskId ? "in_progress" : "returned";
        }
      }
      continue;
    }
    const p = jsonObject(r.payload), item = jsonObject(p?.item);
    const isEnvelope = r.type === "event_msg", isCompleted = p?.type === "item_completed", isStarted = p?.type === "item_started";
    if (item?.type === "CommandExecution" && typeof item.id === "string" && (isCompleted || isStarted)) {
      count(isEnvelope ? (isCompleted ? "codex_command_completed" : "codex_command_started") : "codex_command_other_envelope");
      const key = `codex:${text(p?.thread_id) ?? "?"}:${item.id}`;
      observeReference(key, isCompleted ? "result" : "call");
      if (isCompleted) resultKeys.add(key);
      const command = codexCommand(item.command);
      const cwd = codexWorkdir(item.cwd);
      const old = candidates.get(key);
      if (command === null && !old) continue;
      const c = old ?? fresh(key, "codex_command_execution", command ?? "", cwd, isStarted ? at : null);
      if (!old) c.startObserved = isStarted;
      // 시작/결과의 상충을 먼저 남긴다. 아래 값은 해당 대표 이벤트의 D2 대조용이다.
      if (old) c.pairAmbiguous ||= (isStarted && old.resultObserved) ||
        (command !== null && command !== old.command) || (typeof item.cwd === "string" && old.cwd !== null && cwd !== old.cwd);
      if (command !== null) c.relatedToTarget ||= isRelated(command, cwd);
      c.origin = { line: lineIndex, item: 0 };
      if (command !== null) c.command = command;
      if (typeof item.cwd === "string") c.cwd = cwd;
      c.parserSupported = isEnvelope && isCompleted;
      if (isStarted) { c.startObserved = true; c.callAt ??= at; c.combined = false; }
      else { c.resultObserved = true; c.resultAt = at; c.combined = !c.startObserved; Object.assign(c, observeNumeric(item)); }
      c.completion = state(item.status);
      candidates.set(key, c);
      continue;
    }
    if (r.type === "response_item" && p && (p.type === "function_call" || p.type === "function_call_output")) {
      count(p.type === "function_call" ? "codex_function_call" : "codex_function_result");
      if (typeof p.call_id !== "string") continue; const key = `function:${p.call_id}`;
      observeReference(key, p.type === "function_call" ? "call" : "result");
      if (p.type === "function_call") {
        if (p.name !== "exec_command" && p.name !== "command") continue;
        let args = jsonObject(p.arguments);
        if (typeof p.arguments === "string") { try { args = jsonObject(JSON.parse(p.arguments)); } catch { /* 지원하지 않는 인자 */ } }
        const command = text(args?.cmd ?? args?.command); if (command === null) continue;
        const candidate = { ...fresh(key, "codex_function_call", command, text(args?.workdir ?? args?.cwd), at), pairAmbiguous: resultKeys.has(key) };
        candidate.relatedToTarget ||= candidates.get(key)?.relatedToTarget ?? false;
        candidates.set(key, candidate);
      } else {
        resultKeys.add(key); const c = candidates.get(key); if (c) { c.origin = { line: lineIndex, item: 0 }; c.resultObserved = true; c.resultAt = at; c.completion = "returned"; }
      }
      continue;
    }
    if (isEnvelope && p && (p.type === "exec_command_begin" || p.type === "exec_command_end")) {
      count(p.type === "exec_command_begin" ? "codex_exec_begin" : "codex_exec_end");
      if (typeof p.call_id !== "string") continue; const key = `exec:${p.call_id}`;
      observeReference(key, p.type === "exec_command_begin" ? "call" : "result");
      const command = codexCommand(p.command), old = candidates.get(key);
      if (command === null && !old) { if (p.type === "exec_command_end") resultKeys.add(key); continue; }
      const begin = p.type === "exec_command_begin";
      const c = old ?? fresh(key, "codex_exec_event", command ?? "", text(p.cwd), at, begin);
      if (!old && begin && resultKeys.has(key)) c.pairAmbiguous = true;
      if (command !== null) c.relatedToTarget ||= isRelated(command, text(p.cwd));
      c.origin = { line: lineIndex, item: 0 };
      if (old) {
        const repeated = begin ? old.callObserved : old.resultObserved;
        c.duplicateReference ||= repeated;
        c.pairAmbiguous ||= repeated || (begin && old.resultObserved) ||
          (command !== null && command !== old.command) || (typeof p.cwd === "string" && old.cwd !== null && p.cwd !== old.cwd);
      }
      if (begin) { c.callObserved = true; c.startObserved = true; c.callAt ??= at; }
      else { resultKeys.add(key); c.resultObserved = true; c.resultAt = at; Object.assign(c, observeNumeric(p)); c.completion = "returned"; }
      candidates.set(key, c); continue;
    }
    count(r.type === "session_meta" ? "codex_session_meta" : item?.type === "McpToolCall" ? "codex_mcp_item"
      : r.type === "response_item" && p?.type === "custom_tool_call" ? "codex_custom_call"
      : r.type === "response_item" && p?.type === "custom_tool_call_output" ? "codex_custom_result" : "other");
  }
  const since = Date.parse(input.since), related: Record<string, unknown>[] = [];
  if (!input.commandRedacted) for (const c of candidates.values()) {
    const proof = commandObservation(c.command, input.command, c.cwd, input.cwd);
    if (!c.relatedToTarget) continue;
    const times = [c.callAt, c.resultAt].filter((t): t is string => t !== null).map(t => Date.parse(t));
    const missingTime = (c.startObserved && !c.callAt) || (c.resultObserved && !c.resultAt);
    const contractTime = missingTime || !times.length ? "unknown" : times.some(t => t < since) && times.some(t => t >= since) ? "spans" : times.every(t => t < since) ? "before" : "after";
    const e = parsed.get(originKey(c.origin));
    const sameEvent = (entry: ExecRecord | undefined) => c.parserSupported && entry?.ref === c.rawRef && entry.command === c.command && entry.cwd === c.cwd && Date.parse(entry.at) === Date.parse(c.resultAt ?? c.callAt ?? "");
    const sameParsed = sameEvent(e), sameCurrent = sameEvent(current.get(originKey(c.origin)));
    const duplicateReference = c.duplicateReference || duplicateReferences.has(c.rawRef);
    const reversedTime = c.startObserved && c.callAt !== null && c.resultAt !== null && Date.parse(c.resultAt) < Date.parse(c.callAt);
    const pairAmbiguous = c.pairAmbiguous || reversedTime || (!c.combined && duplicateReference);
    related.push({ ref: fingerprint(`${c.rawRef}\0${originKey(c.origin)}`), format: c.format, parserSupported: c.parserSupported,
      callObserved: c.callObserved, startObserved: c.startObserved, resultObserved: c.resultObserved, pair: pairAmbiguous ? "ambiguous" : c.combined ? "combined" : !c.callObserved ? "missing_call" : c.resultObserved ? "paired" : "missing_result",
      duplicateReference, identityAmbiguous: pairAmbiguous || duplicateReference,
      callAt: pairAmbiguous ? null : c.callAt, resultAt: c.resultAt, contractTime, commandMatch: proof.commandMatch, cwdMatch: proof.cwdMatch, proof: proof.proof,
      completion: pairAmbiguous ? "unknown" : c.completion, numericExit: c.numericExit, numericObservation: c.numericObservation, parsedExit: sameParsed ? numeric(e?.exitCode) : null, inCurrentParser: sameCurrent });
  }
  const runs = input.current.map(e => ({ e, ...commandObservation(e.command, input.command, e.cwd, input.cwd) })).filter(e => e.proof !== "absent");
  const last = runs.at(-1);
  const status = input.commandRedacted ? "unavailable" : input.matched ? "matched" : !last ? "not_found" : last.proof === "masked" ? "masked" : last.e.exitCode !== 0 ? "not_passed" : "not_available_for_task";
  const lastLine = input.text.slice(input.text.lastIndexOf("\n") + 1);
  let tail = input.range.wholeWindowFragment ? "fragment_without_boundary" : input.text.endsWith("\n") || !input.text ? "newline" : "partial_or_invalid";
  if (lastLine.trim()) { try { JSON.parse(lastLine); tail = "valid_json_without_newline"; } catch { /* 조각난 끝 */ } }
  const { bytesComplete, ...range } = input.range;
  return { read: { ...range, tail, invalidLines, complete: bytesComplete && range.stable && !range.headTruncated && tail === "newline" && invalidLines === 0 },
    comparison: { scope: "observed_window_only", commandRedacted: input.commandRedacted, status },
    events: { kinds, candidates: related.slice(-24), omittedCandidates: Math.max(0, related.length - 24), orphanResults: [...resultKeys].filter(k => !candidates.get(k)?.callObserved || !candidates.get(k)?.resultObserved).length } };
}
