/** Compare one persisted IAMCEO dispatch with its native Codex transcript.
 * Usage: bun scripts/inspect-codex-turn.ts --database /path/iamceo.db --codex-home /path/.codex --run UUID [--socket /path/core.sock]
 * A terminal observation and a past native completion are independent, read-only findings.
 * This diagnostic never types into a terminal or changes a journal, approval, lease, or task.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { coreRpc, type CoreTerminal } from "../server/runner/core-client.ts";
import type { RunnerTerminalIdentity } from "../server/runner/types.ts";
import { codexDraft } from "../server/runner/core.ts";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { hasExactMarker, jsonObject, parseCodexSessionMeta, parseProviderUserText, providerLogPath, readJsonlRange, type JsonlCursor } from "../server/runner/delivery-evidence.ts";

const inputPrefixes = [
  "",
  "IAMCEO execution preference: Work sequentially for this task; do not spawn subagents.\n\n",
  "IAMCEO execution preference: Use native subagents for independent parts of your assigned work when useful. Choose and coordinate them yourself within your existing tool permissions and approvals.\n\n",
  "IAMCEO execution preference: Use native subagents for independent work in parallel when useful; retain your normal approvals and tool access.\n\n",
];

interface DispatchInput { sessionId: string; cwd: string; marker: string; wireText: string; since: string }
export interface CompletedCodexTurn { turnId: string; completedAt: string; cursor: JsonlCursor }

/** Only the latest complete turn in the parent CLI's own rollout. A child, quote, copied
 * request, missing start, corrupt/partial suffix or any record after completion is insufficient. */
export function readCompletedCodexTurn(root: string, path: string, input: DispatchInput): CompletedCodexTurn | null {
  const target = providerLogPath(root, path);
  const since = Date.parse(input.since);
  if (!target || !Number.isFinite(since) || !/^#iamceo_b_[A-Za-z0-9_-]{22}$/.test(input.marker) || !hasExactMarker(input.wireText, input.marker)) return null;
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const stat = fstatSync(fd), fileIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    if (!stat.isFile()) return null;
    const head = readJsonlRange(root, path, null, { maxRecords: 1, maxBytes: 1024 * 1024, fileIdentity });
    const meta = parseCodexSessionMeta(head.records[0]?.value);
    if (meta?.sessionId !== input.sessionId || meta.cwd !== input.cwd || jsonObject(jsonObject(head.records[0]?.value)?.payload)?.source !== "cli") return null;
    // Bound both I/O and parsing when a thread spans hundreds of MB. A turn larger
    // than the inspected suffix simply remains unknown.
    let startOffset = Math.max(0, stat.size - 8 * 1024 * 1024);
    if (startOffset) {
      const chunk = Buffer.alloc(64 * 1024);
      let newline = -1;
      while (startOffset < stat.size && newline < 0) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - startOffset), startOffset);
        if (!n) return null;
        newline = chunk.subarray(0, n).indexOf(10);
        startOffset += newline < 0 ? n : newline + 1;
      }
      if (newline < 0) return null;
    }
    let range = readJsonlRange(root, path, null, { startOffset, fileIdentity });
    const records = range.records.map(row => jsonObject(row.value));
    while (!range.complete && range.code === "scan_pending" && range.cursor && range.cursor.readOffset < stat.size && range.bytesRead) {
      range = readJsonlRange(root, path, range.cursor, { startOffset, fileIdentity });
      records.push(...range.records.map(row => jsonObject(row.value)));
    }
    if (!range.complete || !range.cursor || range.cursor.offset !== stat.size || fstatSync(fd).mtimeMs !== stat.mtimeMs) return null;
    const last = records.at(-1), ended = jsonObject(last?.payload);
    if (last?.type !== "event_msg" || ended?.type !== "task_complete" || typeof ended.turn_id !== "string" || ended.root_turn_id !== ended.turn_id || typeof last.timestamp !== "string") return null;
    const turnId = ended.turn_id, completedAt = Date.parse(last.timestamp);
    const start = records.findLastIndex(row => row?.type === "event_msg" && jsonObject(row.payload)?.type === "task_started");
    if (start < 0 || !Number.isFinite(completedAt)) return null;
    const first = records[start]!, begun = jsonObject(first.payload), startedAt = Date.parse(String(first.timestamp));
    if (begun?.turn_id !== turnId || begun.root_turn_id !== turnId || !Number.isFinite(startedAt) || startedAt < since || completedAt < startedAt) return null;
    const expected = inputPrefixes.map(prefix => prefix + input.wireText);
    let received = false;
    for (const entry of records.slice(start + 1, -1)) {
      const payload = jsonObject(entry?.payload);
      if (!entry || !payload || entry.type === "session_meta" || (payload.turn_id !== undefined && payload.turn_id !== turnId)) return null;
      if (entry.type === "event_msg" && ["turn_aborted", "task_complete", "error"].includes(String(payload.type))) return null;
      const item = jsonObject(payload.item);
      if (entry.type === "event_msg" && payload.type === "item_completed" && item?.type === "UserMessage") {
        const content = Array.isArray(item.content) && item.content.length === 1 ? jsonObject(item.content[0]) : null;
        if (payload.thread_id !== input.sessionId || payload.turn_id !== turnId || content?.type !== "text" ||
            typeof content.text !== "string" || !expected.includes(content.text)) return null;
      }
      if (entry.type === "response_item" && payload.role === "user" || entry.type === "event_msg" && payload.type === "user_message") {
        const user = parseProviderUserText("codex", entry);
        if (user?.texts.length !== 1 || !expected.includes(user.texts[0]!) || (user.sessionId && user.sessionId !== input.sessionId) || (user.cwd && user.cwd !== input.cwd)) return null;
        if (entry.type === "response_item") {
          if (received) return null;
          received = true;
        }
      }
    }
    return received ? { turnId, completedAt: last.timestamp, cursor: range.cursor } : null;
  } catch { return null; } finally { closeSync(fd); }
}

export function settledCodexComposer(screen: string): boolean {
  screen = screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  if (codexDraft(screen) !== "" || !/^\s*(?:← for agents · )?\? for shortcuts(?:\s+⚠ \d+ warnings? · f2 to view)?\s*$/m.test(screen.trimEnd().split("\n").at(-1) ?? "")) return false;
  return !/(?:esc to interrupt|^\s*(?:\d+ background terminal|queued messages|would you like to run the following command\?))/im.test(screen);
}

interface DispatchRow {
  id: string; project_id: string; member_id: string; bundle_marker: string; wire_text: string; wire_sha256: string;
  dispatch_identity: string; run_identity: string; transport_state: string; created_at: string; phase: string;
  input_received_at: string | null; ended_at: string | null; turn: number | null; cwd: string; session_generation: number;
  session_id: string | null; pane_id: string | null;
}
function sameOwner(terminal: CoreTerminal, row: DispatchRow, identity: RunnerTerminalIdentity): boolean {
  return terminal.state === "live" && terminal.address === identity.terminalId && !!identity.process?.pid && terminal.pid === identity.process.pid &&
    terminal.labels?.["iamceo.member"] === row.member_id && terminal.labels["iamceo.project"] === row.project_id &&
    terminal.labels["iamceo.cli"] === "codex" && terminal.labels["iamceo.generation"] === String(identity.sessionGeneration) &&
    (!terminal.labels["iamceo.session"] || terminal.labels["iamceo.session"] === identity.sessionId) &&
    row.session_generation === identity.sessionGeneration && row.session_id === identity.sessionId && row.pane_id === terminal.address && terminal.cwd === row.cwd;
}
async function observeTerminal(socket: string, row: DispatchRow, identity: RunnerTerminalIdentity) {
  const terminal = identity.terminalId;
  if (!terminal) return { ownership: "unknown" };
  try {
    const before = await coreRpc<CoreTerminal>(socket, "terminal.get", { terminal });
    if (!sameOwner(before, row, identity)) return { ownership: "changed" };
    const screen = await coreRpc<{ text: string; complete?: boolean }>(socket, "terminal.read", { terminal, lines: 0 });
    const after = await coreRpc<CoreTerminal>(socket, "terminal.get", { terminal });
    if (!sameOwner(after, row, identity) || before.turn !== after.turn || before.status?.state !== after.status?.state) return { ownership: "changed" };
    return { ownership: "verified", coreState: after.status?.state ?? null, coreTurn: after.turn ?? null,
      settledComposer: screen.complete === true ? settledCodexComposer(screen.text) : null };
  } catch { return { ownership: "unknown" }; }
}

interface Options { database: string; codexHome: string; run: string; socket?: string }
export async function inspectCodexTurn(options: Options) {
  const db = new Database(options.database, { readonly: true });
  let row: DispatchRow | null;
  try {
    row = db.query<DispatchRow, [string]>(`SELECT d.id,d.project_id,d.member_id,d.bundle_marker,d.wire_text,d.wire_sha256,d.terminal_identity_json AS dispatch_identity,
      j.terminal_identity_json AS run_identity,d.transport_state,d.created_at,j.phase,j.input_received_at,j.ended_at,j.turn,
      m.cwd,m.session_generation,m.session_id,m.pane_id FROM delivery_dispatches d
      JOIN execution_journal j ON j.run_id=d.id AND j.member_id=d.member_id AND j.project_id=d.project_id
      JOIN members m ON m.id=d.member_id AND m.project_id=d.project_id WHERE d.id=? AND d.cli='codex' AND d.backend='core'`).get(options.run);
  } finally { db.close(); }
  if (!row) throw new Error("No matching Core/Codex dispatch and execution journal");
  const identity = JSON.parse(row.dispatch_identity) as RunnerTerminalIdentity;
  const original = JSON.parse(row.run_identity) as RunnerTerminalIdentity;
  let completion: CompletedCodexTurn | null = null;
  if (row.transport_state === "accepted" && row.input_received_at && identity.sessionId &&
      original.sessionId === identity.sessionId && original.sessionGeneration === identity.sessionGeneration &&
      original.terminalId === identity.terminalId && original.process?.pid === identity.process?.pid &&
      createHash("sha256").update(row.wire_text).digest("hex") === row.wire_sha256) {
    const home = resolve(options.codexHome);
    const native = new Database(join(home, "state_5.sqlite"), { readonly: true });
    try {
      const thread = native.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id=?").get(identity.sessionId);
      if (thread) completion = readCompletedCodexTurn(join(home, "sessions"), thread.rollout_path, {
        sessionId: identity.sessionId, cwd: row.cwd, marker: row.bundle_marker, wireText: row.wire_text, since: row.created_at,
      });
    } finally { native.close(); }
  }
  return { runId: row.id, memberId: row.member_id, projectId: row.project_id, sessionId: identity.sessionId,
    journal: { phase: row.phase, turn: row.turn, inputReceivedAt: row.input_received_at, endedAt: row.ended_at },
    nativeCompletion: completion ? { turnId: completion.turnId, completedAt: completion.completedAt } : null,
    terminal: options.socket ? await observeTerminal(options.socket, row, identity) : null };
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
      database: { type: "string" }, "codex-home": { type: "string" }, run: { type: "string" }, socket: { type: "string" },
    } });
    if (!values.database || !values["codex-home"] || !values.run) throw new Error("Required: --database PATH --codex-home PATH --run ID. Optional: --socket PATH");
    console.log(JSON.stringify(await inspectCodexTurn({ database: values.database, codexHome: values["codex-home"], run: values.run, socket: values.socket }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to inspect Codex turn");
    process.exitCode = 1;
  }
}
