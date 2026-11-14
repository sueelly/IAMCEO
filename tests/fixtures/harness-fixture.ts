// 공통 하네스 시험의 격리 설정: 가짜 core 실행기, 격리 데이터 폴더, 가짜 Claude 세션 기록.
// 실제 직원·대표 화면·운영 DB·제공자 기록에는 아무것도 쓰지 않는다.
import { afterEach } from "bun:test";
import { Bus } from "../../server/bus.ts";
import { loadConfig } from "../../server/config.ts";
import { openDb } from "../../server/db.ts";
import { Orchestrator } from "../../server/orchestrator.ts";
import { Store } from "../../server/store.ts";
import type { Backend, Member } from "../../shared/types.ts";
import type { Runner, RunnerEvent, RunnerMember, SendResult } from "../../server/runner/types.ts";
import { createIsolatedRuntime } from "./isolated-runtime.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { transcriptPath } from "../../server/runner/transcript.ts";

let execSeq = 0;
/** 가짜 Claude 세션 기록(격리 폴더)에 Bash 실행 한 건을 남긴다. exit 0 이면 성공 기록, 아니면 'Exit code N' 오류 기록. */
export function writeExec(claudeHome: string, member: Member, command: string, exit = 0, output = "ok") {
  const path = transcriptPath(member.cwd, member.sessionId!, claudeHome);
  mkdirSync(dirname(path), { recursive: true });
  const id = `toolu_${++execSeq}_${Math.random().toString(36).slice(2, 8)}`;
  const at = new Date().toISOString();
  const lines = [
    { type: "assistant", timestamp: at, cwd: member.cwd, sessionId: member.sessionId, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } },
    exit === 0
      ? { type: "user", timestamp: at, cwd: member.cwd, sessionId: member.sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: false }] }, toolUseResult: { stdout: output, stderr: "", interrupted: false, isImage: false } }
      : { type: "user", timestamp: at, cwd: member.cwd, sessionId: member.sessionId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Exit code ${exit}\n${output}`, is_error: true }] }, toolUseResult: `Error: Exit code ${exit}` },
  ];
  appendFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return id;
}
/** 가짜 Claude 세션 기록에 다른 도구(Read·WebFetch 등) 결과 한 건을 남긴다. */
export function writeToolResult(claudeHome: string, member: Member, name: string, input: Record<string, unknown>, text: string) {
  const path = transcriptPath(member.cwd, member.sessionId!, claudeHome);
  mkdirSync(dirname(path), { recursive: true });
  const id = `toolu_${++execSeq}_r`;
  const at = new Date().toISOString();
  appendFileSync(path, [
    { type: "assistant", timestamp: at, cwd: member.cwd, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } },
    { type: "user", timestamp: at, cwd: member.cwd, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
}

export class FakeRunner implements Runner {
  readonly kind: Backend = "core";
  sent: { memberId: string; text: string }[] = [];
  busy = new Set<string>();
  callback: (event: RunnerEvent) => void = () => {};
  async available() { return { ok: true }; }
  async start(m: RunnerMember) { return { sessionId: m.sessionId ?? `session-${m.id}`, paneId: `pane-${m.id}` }; }
  async send(m: RunnerMember, text: string): Promise<SendResult> { this.sent.push({ memberId: m.id, text }); this.busy.add(m.id); return { ok: true, started: false, turn: 0 }; }
  isBusy(id: string) { return this.busy.has(id); }
  async compact(): Promise<SendResult> { return { ok: true }; }
  async setParallel(): Promise<SendResult> { return { ok: true }; }
  async interrupt() {}
  async stop(m: RunnerMember) { this.busy.delete(m.id); }
  async screen() { return ""; }
  on(callback: (event: RunnerEvent) => void) { this.callback = callback; }
  async shutdown() {}
  to(member: Member) { return this.sent.filter(s => s.memberId === member.id).map(s => s.text); }
  end(member: Member, turn = 0) { this.busy.delete(member.id); this.callback({ type: "turn_end", memberId: member.id, terminalId: member.paneId, sessionGeneration: 0, turn, isError: false, finalText: "" }); }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
export async function until(what: string, check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  if (!check()) throw new Error(`기다리다 끝남: ${what}`);
}

export function fixture() {
  const isolated = createIsolatedRuntime();
  const config = loadConfig({ IAMCEO_HOME: isolated.paths.iamceoHome, IAMCEO_PORT: "0", IAMCEO_CORE_SOCKET: isolated.socketPath, IAMCEO_CORE_BIN: isolated.bins.coreBin, IAMCEO_CLAUDE_BIN: isolated.bins.claudeBin, IAMCEO_CODEX_BIN: isolated.bins.codexBin });
  const db = openDb(config.dbPath);
  const store = new Store(db, new Bus());
  store.patchSettings({ maxConcurrentTurns: 3, boardTidyHours: 0 });
  const project = store.createProject({ name: "하네스", cwd: isolated.paths.work });
  const runner = new FakeRunner();
  const orch = new Orchestrator({ config, store, runners: new Map([["core", runner]]), providerHomes: isolated.providerHomes, timings: { tickMs: 60_000, healthMs: 60_000, turnErrorRetryMs: 1000 } });
  const make = (handle: string, name: string, kind: "conductor" | "worker", cli: "claude" | "codex" | "antigravity" = "claude") => store.createMember({ projectId: project.id, handle, name, kind, origin: "runner", backend: "core", status: "idle", cwd: isolated.paths.work, paneId: `pane-${handle}`, sessionId: `session-${handle}`, cli });
  const lead = make("lead", "총괄", "conductor");
  const worker = make("w1", "철수", "worker");
  const worker2 = make("w2", "영희", "worker");
  const tool = async (member: Member, name: string, args: Record<string, unknown>) => orch.handleAgentTool(store.requireMember(member.id), name, args);
  cleanups.push(async () => { await orch.shutdown(); db.close(); await isolated.stop(); });
  /** 검사 명령을 이 직원 세션 기록에 '돌린 것'으로 남긴다(격리 폴더의 가짜 기록). */
  const ran = (member: Member, ...commands: string[]) => { for (const c of commands) writeExec(isolated.paths.claudeHome, store.requireMember(member.id), c); };
  return { store, project, runner, orch, lead, worker, worker2, tool, make, ran, isolated, config };
}

export const CODING = {
  kind: "coding",
  goal: "보고 화면에 검사 줄을 보인다",
  acceptance: ["완료 보고 아래에 검사 결과가 한 줄로 보인다", "검사가 없으면 완료가 거절된다"],
  scope: "server/ 안에서만 고친다",
  forbidden: ["깃허브에 올리지 않는다", "임시 폴더를 지우지 않는다"],
  evidence: ["시험 이름과 통과 수"],
};
export const pass = (kind: string, criterion?: number, name = kind) => ({ name, kind, result: "pass", evidence: `${name} 12 pass 0 fail`, command: `bun test ${name}`, ...(criterion ? { criterion } : {}) });

