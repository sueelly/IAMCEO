import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCodexTurn, readCompletedCodexTurn, settledCodexComposer } from "../scripts/inspect-codex-turn.ts";

const sessionId = "session-1", cwd = "/test", marker = "#iamceo_b_" + "A".repeat(22);
const wireText = "Review the change\n" + marker;
const at = "2026-11-18T05:34:00.000Z", since = "2026-11-18T05:33:00.000Z";
const event = (type: string, turn_id: string) => ({ timestamp: at, type: "event_msg", payload: { type, turn_id, root_turn_id: turn_id } });
const user = (text: string, role = "user") => ({ type: "response_item", timestamp: at, payload: { type: "message", role, content: [{ type: "input_text", text }] } });
const meta = { type: "session_meta", payload: { id: sessionId, cwd, source: "cli" } };
const start = event("task_started", "turn-one"), end = event("task_complete", "turn-one");
const item = (text: string) => ({ type: "event_msg", timestamp: at, payload: { type: "item_completed", thread_id: sessionId, turn_id: "turn-one", item: { type: "UserMessage", content: [{ type: "text", text }] } } });
const rows = [start, user("IAMCEO execution preference: Work sequentially for this task; do not spawn subagents.\n\n" + wireText), end];
function fixture(run: (root: string, path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "iamceo-completed-codex-"));
  try { run(root, join(root, "rollout.jsonl")); } finally { rmSync(root, { recursive: true, force: true }); }
}
function write(path: string, data: unknown[]) { writeFileSync(path, data.map(x => JSON.stringify(x) + "\n").join("")); }
const proof = (root: string, path: string) => readCompletedCodexTurn(root, path, { sessionId, cwd, marker, wireText, since });
test("only the original dispatch in the latest completed main-session turn proves completion", () => fixture((root, path) => {
  write(path, [meta, { type: "prior", padding: "x".repeat(9 * 1024 * 1024) }, ...rows]);
  expect(proof(root, path)).toMatchObject({ turnId: "turn-one", completedAt: at });
  for (const data of [
    [start, user(wireText, "assistant"), end], [start, user("quoted " + marker), end],
    [start, user(wireText), event("task_complete", "another")], [start, user(wireText), event("turn_aborted", "turn-one"), end],
    [...rows, event("task_started", "next")], [...rows, user("human input")], [...rows, { type: "new_activity" }],
    [start, user(wireText), user("human input"), end], [start, user(wireText), item("human steering"), end], [start, user(wireText + "x"), end],
    [start, { ...user(wireText), isReplay: true }, end], [start, user(wireText), { ...end, timestamp: "invalid" }],
  ]) {
    write(path, [meta, ...data]); expect(proof(root, path)).toBeNull();
  }
  write(path, [{ ...meta, payload: { ...meta.payload, id: "foreign" } }, ...rows]); expect(proof(root, path)).toBeNull();
  write(path, [meta, ...rows]); appendFileSync(path, '{"type":"partial"'); expect(proof(root, path)).toBeNull();
}));
test("a native idle composer requires its footer and rejects active or queued work", () => {
  const cli = "› Ask Codex to do anything\n  GPT-6-Astra high · /tmp\n  ← for agents · ? for shortcuts";
  expect(settledCodexComposer("• Worked for 1m 38s • 2:35 PM\n" + cli)).toBe(true);
  for (const screen of ["›", "› typed\n  ? for shortcuts", "Working (esc to interrupt)\n" + cli,
    "1 background terminal running\n" + cli, "Queued messages\n" + cli, "Would you like to run the following command?\n" + cli]) expect(settledCodexComposer(screen)).toBe(false);
});

test("read-only diagnosis selects the specified accepted run and never emits its wire text", async () => {
  const root = mkdtempSync(join(tmpdir(), "iamceo-codex-run-"));
  try {
    const database = join(root, "iamceo.db"), codexHome = join(root, "codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    const path = join(codexHome, "sessions", "rollout.jsonl");
    write(path, [meta, ...rows]);
    const native = new Database(join(codexHome, "state_5.sqlite"), { create: true });
    native.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT)");
    native.query("INSERT INTO threads VALUES (?, ?)").run(sessionId, path);
    native.close();
    const db = new Database(database, { create: true });
    db.exec("CREATE TABLE delivery_dispatches (id TEXT, project_id TEXT, member_id TEXT, cli TEXT, backend TEXT, bundle_marker TEXT, wire_text TEXT, wire_sha256 TEXT, terminal_identity_json TEXT, transport_state TEXT, created_at TEXT)");
    db.exec("CREATE TABLE execution_journal (run_id TEXT, member_id TEXT, project_id TEXT, terminal_identity_json TEXT, phase TEXT, input_received_at TEXT, ended_at TEXT, turn INTEGER)");
    db.exec("CREATE TABLE members (id TEXT, project_id TEXT, cwd TEXT, session_generation INTEGER, session_id TEXT, pane_id TEXT)");
    const identity = JSON.stringify({ terminalId: "t1", sessionId, sessionGeneration: 7, process: { pid: 9, startedAt: null } });
    db.query("INSERT INTO delivery_dispatches VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("run", "p", "m", "codex", "core", marker, wireText, createHash("sha256").update(wireText).digest("hex"), identity, "accepted", since);
    db.query("INSERT INTO execution_journal VALUES (?,?,?,?,?,?,?,?)").run("run", "m", "p", identity, "running", at, null, 2);
    db.query("INSERT INTO members VALUES (?,?,?,?,?,?)").run("m", "p", cwd, 7, sessionId, "t1");
    db.close();
    const options = { database, codexHome, run: "run" };
    const result = await inspectCodexTurn(options);
    expect(result).toMatchObject({ runId: "run", journal: { phase: "running", turn: 2 }, nativeCompletion: { turnId: "turn-one", completedAt: at }, terminal: null });
    expect(JSON.stringify(result)).not.toContain("Review the change");
    const methods: string[] = [], socketPath = join(root, "core.sock");
    const server = createServer(socket => {
      socket.once("data", data => {
        const request = JSON.parse(data.toString());
        methods.push(request.method);
        const terminal = { address: "t1", state: "live", pid: 9, turn: 2, status: { state: "working" }, cwd, argv: ["/tmp/codex"],
          labels: { "iamceo.member": "m", "iamceo.project": "p", "iamceo.cli": "codex", "iamceo.generation": "7" } };
        const snapshot = request.method === "terminal.read" ? { complete: true, text: "› Ask Codex to do anything\n  ? for shortcuts" } : terminal;
        socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: snapshot }) + "\n");
      });
    });
    await new Promise<void>(done => server.listen(socketPath, done));
    try {
      const live = await inspectCodexTurn({ ...options, socket: socketPath });
      expect(live.terminal).toMatchObject({ ownership: "verified", coreState: "working", coreTurn: 2, settledComposer: true });
      expect(methods).toEqual(["terminal.get", "terminal.read", "terminal.get"]);
    } finally { await new Promise<void>(done => server.close(() => done())); }

    const changed = new Database(database); changed.exec("UPDATE delivery_dispatches SET transport_state='unknown'"); changed.close();
    expect((await inspectCodexTurn(options)).nativeCompletion).toBeNull();
    const missing = join(root, "missing.db");
    await expect(inspectCodexTurn({ ...options, database: missing })).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
