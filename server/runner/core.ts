import { capturedContext } from "./statusline.ts";
import { readCodexContextFile } from "./codex-context.ts";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, opendirSync, openSync, readSync, readdirSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ApprovalPrompt, Backend, NativePrompt } from "../../shared/types.ts";
import { claudeFolderTrust, codexFolderTrust } from "./core-approval.ts";
import { antigravityDraft, antigravityExactComposer, antigravityFolderTrust, antigravityMemberHome, discoverAntigravityConversation, existingAntigravityTranscript, readAntigravityContext } from "./antigravity.ts";
import { cleanText } from "../text.ts";
import { limitedPrompt, parseNativePrompt } from "./prompt.ts";
import { childEnv } from "./headless.ts";
import { backgroundWait, defaultClaudeHome, findSessionFile, inputText, screenContextPct } from "./herdr.ts";
import { CoreError, coreRpc, coreSocketPath, type CoreHello, type CoreTerminal } from "./core-client.ts";
import { providerFor, providerLaunch, isProviderArgv, type CoreProvider, type ProviderBins } from "./providers.ts";
import { codexBindingMarker, discoverCodexSession, observeCompactBoundary, type CodexBindingCursor, type CompactBoundaryBaseline, type CompactBoundaryCursor } from "./core-context.ts";
import { readDeliveryEvidence, readJsonlRange, parseCodexSessionMeta, providerLogPath, type DeliveryEvidenceCursor, type JsonlCursor } from "./delivery-evidence.ts";
import type { DeliveryDispatch, RunnerRecoveryStore, TerminalLease } from "../service-contracts.ts";
import { readTranscriptTail } from "./transcript.ts";
import type { NativePromptAnswer, Runner, RunnerEvent, RunnerMember, SendResult, StartOpts, RunnerWriteOptions, TerminalControlAction, TerminalControlResult, DeliveryProbe, DeliveryInspection, DeliveryRepair, RunnerTerminalIdentity, RunnerReattachResult, RunnerObservation } from "./types.ts";

/** claudeHome: Claude session transcripts (default CLAUDE_CONFIG_DIR or ~/.claude), read for context usage only. */
export interface CoreRunnerOptions extends ProviderBins { coreBin?: string; socketPath?: string; session?: string; stateDir?: string; configDir?: string; claudeHome?: string; codexHome?: string; contextHome?: string }
export interface CoreCompactState {
  id: string; baseline: CompactBoundaryBaseline; phase: "sending" | "running" | "uncertain" | "succeeded" | "failed";
  startedAt: number; cursor: CompactBoundaryCursor | null;
  reason?: "user_resolved";
  /** Only acknowledged human input can arm resolution; idle alone is insufficient. */
  manualResolution?: { turn: number | null; unsettled: boolean };
}
export interface CoreRunnerDeps {
  pollMs?: number; rpcTimeoutMs?: number; sendTimeoutMs?: number; compactTimeoutMs?: number;
  /** 대표의 답을 넣은 뒤 창이 닫혔는지 다시 읽어 보는 시간(ms). 지나면 '그대로'로 두고 다시 넣지 않는다. */
  acceptCheckMs?: number;
  recoveryStore?: RunnerRecoveryStore;
  /** Synchronous transaction ports. A throw prevents external input. */
  repair?: { load(memberId: string, request: DeliveryRepair): DeliveryDispatch | null; prepare(memberId: string, request: DeliveryRepair, dispatch: DeliveryDispatch): boolean };
  quiescence?: (memberId: string, dispatch: DeliveryDispatch) => { originalWrite: "not_written" | "rejected" | "settled" | "unresolved"; externalInput: boolean | null };
  submitKeyVerified?: boolean;
  compactStore?: { load(memberId: string): CoreCompactState | null; save(memberId: string, state: CoreCompactState): void };
}
interface Track {
  statusKey: string | null;
  background: string | null;
  setupAttempted: string | null;
  /** 질문·선택 창이 새로 뜬 차례. 막힘(blocked)으로 들어올 때마다 1 늘어 같은 내용의 창이 다시 떠도 다르게 센다. */
  promptSeq: number;
  /** 대표가 이미 답한 창(promptKey). 같은 창에 두 번 넣지 않는다. */
  answeredPrompts: string[];
  /** 지금 창(promptKey)을 처음 읽은 시각. 카드 등록 시각으로 보인다. */
  promptSeen: { key: string; at: string } | null;
  setupError: { code: string; note: string } | null;
  member: RunnerMember; terminal: CoreTerminal; sessionId: string | null; pending: boolean; uncertain: boolean; status: string | null;
  epoch: number; endedTurn: number; completing: boolean; refresh: Promise<CoreTerminal> | null;
  nonce: string | null; bindingSince: string; binding: CodexBindingCursor | null; compact: CoreCompactState | null;
  dispatches: DeliveryDispatch[]; evidence: Map<string, DeliveryEvidenceCursor>; lastError: string | null;
  observedAt: string; failures: number; failure: string | null;
}
const REQUIRED_METHODS = ["terminal.run", "terminal.list", "terminal.get", "terminal.read", "terminal.send", "terminal.interrupt", "terminal.kill"];
const unsupported = (detail: string): Extract<SendResult, { ok: false }> => ({ ok: false, reason: "error", retryable: false, deliveryEffect: "not_written", detail });

/** Capture an EOF baseline, not an exhaustive delivery/absence scan of history. */
function compactLogBaseline(root: string, path: string): JsonlCursor | null {
  const target = providerLogPath(root, path);
  if (!target) return null;
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || providerLogPath(root, path) !== target) return null;
    const tail = Buffer.alloc(Math.min(stat.size, 4 * 1024 * 1024));
    const start = stat.size - tail.length;
    if (readSync(fd, tail, 0, tail.length, start) !== tail.length || (tail.length && tail.at(-1) !== 10)) return null;
    // Skip the first potentially partial line. Never adopt a partial EOF or an
    // oversized last line as a completed baseline, even if it contains a marker.
    let offset = start;
    if (start > 0) {
      const previous = Buffer.alloc(1);
      if (readSync(fd, previous, 0, 1, start - 1) !== 1) return null;
      if (previous[0] !== 10) {
        offset += tail.indexOf(10) + 1;
        if (offset <= start || offset === stat.size) return null;
      }
    }
    const range = readJsonlRange(root, path, null, { startOffset: offset, fileIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` });
    return range.complete && range.cursor?.offset === stat.size ? range.cursor : null;
  } catch { return null; }
  finally { closeSync(fd); }
}

/** Terminals belong to core's holders. IAMCEO shutdown only detaches. */
export class CoreRunner implements Runner {
  readonly kind: Backend = "core";
  readonly socketPath: string;
  private readonly rpcTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly tracks = new Map<string, Track>();
  private readonly listeners = new Set<(event: RunnerEvent) => void>();
  private readonly configuring = new Set<string>();
  private readonly parallelPreferences = new Map<string, boolean>();
  private readonly leases = new Map<string, TerminalLease>();
  private readonly lostCodex = new Map<string, number | undefined>();
  private readonly unknownStarts = new Set<string>();
  private readonly sending = new Set<string>();
  private readonly starts = new Map<string, Promise<{ sessionId: string | null; paneId: string; rejoined?: boolean }>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private closed = false;
  private methods = new Set<string>();
  /** 이 실행기 기동마다 다른 표지. 창 차례 키에 넣어, 서버를 다시 띄우기 전에 읽은 카드로는 넣지 않는다(promptSeq 는 다시 1부터 센다). */
  private readonly boot = crypto.randomUUID().replace(/-/g, "").slice(0, 8);

  constructor(private readonly options: CoreRunnerOptions = {}, private readonly deps: CoreRunnerDeps = {}) {
    this.socketPath = options.socketPath || coreSocketPath(options.session);
    this.rpcTimeoutMs = deps.rpcTimeoutMs ?? 8000;
    this.sendTimeoutMs = deps.sendTimeoutMs ?? 20_000;
  }
  private call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.rpcTimeoutMs, beforeWrite?: () => boolean): Promise<T> {
    if (this.closed) return Promise.reject(new CoreError("closed", "CoreRunner is shut down"));
    return coreRpc<T>(this.socketPath, method, params, timeoutMs, beforeWrite);
  }
  async available(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const hello = await this.call<CoreHello>("hello", { generation: 1 });
      if (hello.generation !== 1) throw new CoreError("unsupported_generation", `Unsupported herdr-core generation: ${hello.generation}`);
      const missing = REQUIRED_METHODS.filter((method) => !hello.methods?.includes(method));
      if (missing.length) throw new CoreError("unsupported", `Core is missing methods: ${missing.join(", ")}`);
      this.methods = new Set(hello.methods);
      return { ok: true, detail: `herdr-core ${hello.version} (${this.socketPath}); status requires OSC 7501; attach with hc attach` };
    } catch (error) { return { ok: false, detail: `${error instanceof Error ? error.message : error}. Start herdr-core with ${this.options.coreBin || "hc"} server start` }; }
  }
  on(callback: (event: RunnerEvent) => void): void { this.listeners.add(callback); }
  private emit(event: RunnerEvent): void { for (const callback of this.listeners) callback(event); }
  private observation(track: Track): RunnerObservation {
    return { terminalId: track.terminal.address, ...(track.member.sessionGeneration !== undefined ? { sessionGeneration: track.member.sessionGeneration } : {}), turn: track.terminal.turn ?? null, inputEpoch: track.epoch, observedAt: track.observedAt };
  }
  private event(track: Track, event: RunnerEvent): void { this.emit({ ...this.observation(track), ...event }); }
  private identity(track: Track): RunnerTerminalIdentity {
    return { terminalId: track.terminal.address, sessionId: track.sessionId, sessionGeneration: track.member.sessionGeneration ?? -1,
      process: track.terminal.pid ? { pid: track.terminal.pid, startedAt: null } : null };
  }
  private sameIdentity(a: RunnerTerminalIdentity, b: RunnerTerminalIdentity): boolean {
    return a.terminalId === b.terminalId && a.sessionId === b.sessionId && a.sessionGeneration === b.sessionGeneration && (!a.process || !b.process || a.process.pid === b.process.pid);
  }
  private reserve(memberId: string): () => void {
    if (this.sending.has(memberId)) throw new CoreError("busy", "A terminal input mutation is in progress");
    this.sending.add(memberId);
    return () => this.sending.delete(memberId);
  }
  private bump(track: Track): void { track.epoch++; }
  private restore(track: Track): void {
    const state = this.deps.recoveryStore?.inputState(track.member.id);
    // Recovery phase can lag a durable pre-write refusal across a restart.
    track.dispatches = (state?.unresolvedDispatches ?? []).filter(d => d.transportState !== "rejected");
    track.uncertain ||= track.dispatches.length > 0;
    if (state?.lease && state.lease.expiresAt > Date.now() && this.sameIdentity({ ...state.lease.identity, sessionId: track.sessionId ?? state.lease.identity.sessionId }, { ...this.identity(track), sessionId: track.sessionId ?? state.lease.identity.sessionId })) this.leases.set(track.member.id, state.lease);
    const compact = this.deps.compactStore?.load(track.member.id);
    if (compact && compact.baseline.generation === track.member.sessionGeneration && compact.baseline.terminalId === track.terminal.address && compact.baseline.sessionId === track.sessionId && !["failed", "succeeded"].includes(compact.phase)) {
      track.compact = { ...compact, phase: "uncertain" }; track.uncertain = true;
    }
  }
  private validateTrack(track: Track): void {
    if (this.closed || this.tracks.get(track.member.id) !== track) throw new CoreError("conflict", "Terminal generation changed during operation");
  }
  private assertMember(track: Track, member: RunnerMember): void {
    if (track.member.sessionGeneration !== member.sessionGeneration || track.member.projectId !== member.projectId || providerFor(track.member) !== providerFor(member) || track.member.cwd !== member.cwd || (member.sessionId && track.sessionId && member.sessionId !== track.sessionId)) throw new CoreError("conflict", "Member identity or session generation changed");
  }
  private labels(member: RunnerMember) { return { "iamceo.member": member.id, "iamceo.project": member.projectId, "iamceo.cli": providerFor(member) }; }
  private owns(terminal: CoreTerminal, member: RunnerMember): boolean {
    return Object.entries(this.labels(member)).every(([key, value]) => terminal.labels?.[key] === value) && (member.sessionGeneration === undefined || terminal.labels?.["iamceo.generation"] === String(member.sessionGeneration));
  }
  private name(member: RunnerMember): string { return `iamceo-${createHash("sha256").update(`${member.projectId}:${member.id}`).digest("hex").slice(0, 24)}`; }
  private async bind(member: RunnerMember, terminal: CoreTerminal, sessionId: string | null): Promise<Track> {
    if (this.closed) throw new CoreError("closed", "CoreRunner shut down while starting; terminal remains owned by core");
    const launch = terminal.labels["iamceo.operation"] ? this.deps.recoveryStore?.getLifecycleJournal?.(terminal.labels["iamceo.operation"]) : null;
    const launchedAt = launch?.memberId === member.id && launch.intent === "start" ? launch.createdAt : null;
    const track: Track = { member: { ...member }, terminal, sessionId, pending: false, uncertain: false, status: null, statusKey: null, background: null, setupAttempted: null, setupError: null, promptSeq: 0, answeredPrompts: [], promptSeen: null,
      epoch: 0, endedTurn: terminal.turn ?? 0, completing: false, refresh: null, nonce: terminal.labels["iamceo.binding"] || null, bindingSince: terminal.labels["iamceo.startedAt"] || launchedAt || new Date().toISOString(), binding: null, compact: null,
      dispatches: [], evidence: new Map(), lastError: null, observedAt: new Date().toISOString(), failures: 0, failure: null };
    this.restore(track);
    this.tracks.set(member.id, track);
    await this.observe(track, terminal, true);
    this.event(track, { type: "pane", memberId: member.id, paneId: terminal.address });
    if (sessionId) this.event(track, { type: "session", memberId: member.id, sessionId });
    if (!this.timer) {
      this.timer = setInterval(() => { void this.poll(); }, this.deps.pollMs ?? 1000);
      this.timer.unref?.();
    }
    return track;
  }
  start(member: RunnerMember, opts: StartOpts): Promise<{ sessionId: string | null; paneId: string; rejoined?: boolean }> {
    const pending = this.starts.get(member.id);
    if (pending) return pending;
    let release: () => void;
    try { release = this.reserve(member.id); } catch (error) { return Promise.reject(error); }
    const promise = this.startLocked(member, opts).finally(() => { this.starts.delete(member.id); release(); });
    this.starts.set(member.id, promise);
    return promise;
  }
  private async startLocked(member: RunnerMember, opts: StartOpts) {
    const availability = await this.available();
    if (!availability.ok) throw new CoreError("unavailable", availability.detail || "Core unavailable");
    const snapshot = await this.call<{ terminals: CoreTerminal[] }>("terminal.list", {}).catch(error => {
      // This is before terminal.run: losing a read reply cannot have created a holder.
      // Keep the ambiguous-write fence for terminal.run itself, below.
      if (error instanceof CoreError && error.uncertain) throw new CoreError(error.kind, error.message, false, "not_written", error.causeCode);
      throw error;
    });
    const live = snapshot.terminals.filter((terminal) => terminal.state === "live");
    const joined = await this.reattachFrom(member, live);
    if (joined.outcome === "rejoined") return { sessionId: joined.started.sessionId, paneId: joined.started.paneId!, rejoined: true };
    if (joined.outcome !== "not_found") throw new CoreError(joined.outcome, joined.detail || joined.code);
    if (this.unknownStarts.has(member.id)) throw new CoreError("starting_unknown", "Previous terminal.run may still create a holder; read-only reattach is required");
    // A persisted core pane is evidence of a previous program. Never replace it
    // on a transport failure, a missing snapshot, or an unknown Codex session.
    if (member.origin === "adopted") throw new CoreError("unsupported", "Core does not adopt terminals without IAMCEO ownership labels");
    if (laterNativeId(providerFor(member)) && (member.paneId || (this.lostCodex.has(member.id) && this.lostCodex.get(member.id) === member.sessionGeneration)) && !member.sessionId) throw new CoreError("session_unknown", "The previous Codex/Antigravity terminal is gone and its native session id is unknown; explicitly start a fresh session with context handoff");
    const launch = providerLaunch(member, opts, this.options);
    // Rejoin a live holder first: a new conversation may not have written its
    // transcript yet. Only a conclusively absent local log lets the
    // orchestrator use its existing missing-session handoff path.
    if (opts.resume && member.sessionId && providerFor(member) === "claude" && this.missingClaudeTranscript(member.sessionId)) {
      throw new CoreError("session_missing", `No conversation found with session ID: ${member.sessionId}`, false, "not_written");
    }
    if (opts.resume && member.sessionId && providerFor(member) === "codex" && this.missingCodexTranscript(member.sessionId)) {
      throw new CoreError("session_missing", `Codex session ${member.sessionId} not found in saved or archived sessions`, false, "not_written");
    }
    const env = childEnv();
    for (const key of Object.keys(env)) if (/^(HC_|HERDR_)/.test(key)) delete env[key];
    // The core itself uses isolated XDG directories; its provider programs
    // retain the user's normal configuration/state roots.
    env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    env.XDG_STATE_HOME = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    if (this.options.claudeHome) env.CLAUDE_CONFIG_DIR = this.options.claudeHome;
    if (this.options.codexHome) env.CODEX_HOME = this.options.codexHome;
    Object.assign(env, launch.env);
    const nonce = laterNativeId(providerFor(member)) ? crypto.randomUUID().replaceAll("-", "") : null;
    let terminal: CoreTerminal;
    try { terminal = await this.call<CoreTerminal>("terminal.run", {
      argv: launch.argv, cwd: member.cwd, env, name: this.name(member), size: { cols: 160, rows: 50 },
      labels: { ...this.labels(member), "iamceo.startedAt": new Date().toISOString(), ...(member.sessionGeneration !== undefined ? { "iamceo.generation": String(member.sessionGeneration) } : {}), ...(opts.operationId ? { "iamceo.operation": opts.operationId } : {}), ...(nonce ? { "iamceo.binding": nonce } : {}), ...(launch.sessionId ? { "iamceo.session": launch.sessionId } : {}) },
      no_parent: true, outlive_parent: true, no_notify: true, keep: false, rm: false, wait: false,
    }, this.sendTimeoutMs);
      if (!terminal?.address || !terminal.labels || !Array.isArray(terminal.argv) || terminal.cwd !== member.cwd || !this.owns(terminal, member) || (terminal.turn !== undefined && (!Number.isSafeInteger(terminal.turn) || terminal.turn < 0))) throw new CoreError("protocol", "Invalid terminal.run identity; creation may have occurred", true);
    } catch (error) { if (!(error instanceof CoreError) || error.uncertain) this.unknownStarts.add(member.id); throw error; }
    // A timed-out run may have spawned a holder. A later start first searches
    // the stable member labels/name, rather than replaying terminal.run.
    await this.bind(member, terminal, launch.sessionId);
    return { sessionId: launch.sessionId, paneId: terminal.address };
  }
  private missingClaudeTranscript(sessionId: string): boolean {
    const projects = join(this.options.claudeHome ?? defaultClaudeHome(), "projects");
    let directories: string[];
    try { directories = readdirSync(projects); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    for (const directory of directories) {
      try { statSync(join(projects, directory, `${sessionId}.jsonl`)); return false; }
      catch (error) {
        // Access and I/O failures are not evidence that a conversation is gone.
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      }
    }
    return true;
  }
  /** False includes inconclusive inspection: never rotate a session on an unreadable or partial scan. */
  private missingCodexTranscript(sessionId: string): boolean {
    const home = this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    if (!isAbsolute(home) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) return false;
    const directories = new Map<string, Stats>(), absent = new Set<string>();
    let entries = 0;
    const unchanged = () => {
      for (const [path, before] of directories) {
        const after = lstatSync(path);
        if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return false;
      }
      for (const path of absent) {
        try { lstatSync(path); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
      }
      return true;
    };
    const scan = (path: string, depth: number): boolean => {
      let stat: Stats;
      try { stat = lstatSync(path); }
      catch (error) {
        // Only a missing root is expected; a disappearing descendant invalidates the scan.
        if (depth !== 0 || (error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        absent.add(path); return true;
      }
      if (!stat.isDirectory() || depth > 8) return false;
      directories.set(path, stat);
      // Stream entries with explicit errors. Glob can silently skip unreadable directories.
      const directory = opendirSync(path);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++entries > 10_000) return false;
          if (entry.isDirectory()) { if (!scan(join(path, entry.name), depth + 1)) return false; }
          // Symlinks and other special entries leave the scan incomplete; never follow them.
          else if (!entry.isFile() || (entry.name.startsWith("rollout-") && entry.name.endsWith(`-${sessionId}.jsonl`))) return false;
        }
      } finally { directory.closeSync(); }
      return true;
    };
    try {
      let stat: Stats;
      try { stat = lstatSync(home); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        // ENOENT can also mean a dangling ancestor symlink. Require an inspectable parent.
        const parent = dirname(home), parentStat = lstatSync(parent);
        if (!parentStat.isDirectory()) return false;
        directories.set(parent, parentStat); absent.add(home);
        return unchanged();
      }
      if (!stat.isDirectory()) return false;
      directories.set(home, stat);
      // Native session IDs are independent of the current workspace and may be archived.
      return scan(join(home, "sessions"), 0) && scan(join(home, "archived_sessions"), 0) && unchanged();
    } catch { return false; }
  }
  async reattachOwned(member: RunnerMember): Promise<RunnerReattachResult> {
    const release = this.reserve(member.id);
    try {
      const hello = await this.call<CoreHello>("hello", { generation: 1 });
      if (hello.generation !== 1) return { outcome: "conflict", code: "unsupported_generation" };
      this.methods = new Set(hello.methods);
      const snapshot = await this.call<{ terminals: CoreTerminal[] }>("terminal.list");
      return await this.reattachFrom(member, snapshot.terminals.filter((terminal) => terminal.state === "live"));
    } catch (error) { return { outcome: error instanceof CoreError && error.kind === "conflict" ? "conflict" : "unknown", code: error instanceof CoreError ? error.kind : "error", detail: error instanceof Error ? error.message : String(error) }; }
    finally { release(); }
  }
  private async reattachFrom(member: RunnerMember, live: CoreTerminal[]): Promise<RunnerReattachResult> {
    const matches = live.filter((terminal) => terminal.labels?.["iamceo.member"] === member.id && terminal.labels?.["iamceo.project"] === member.projectId);
    if (member.sessionId && live.some((terminal) => terminal.labels?.["iamceo.session"] === member.sessionId && !this.owns(terminal, member))) return { outcome: "conflict", code: "session_owned", detail: "CLI session is already owned by another live terminal" };
    if (!matches.length) return { outcome: "not_found", code: "no_owned_terminal" };
    if (matches.length !== 1) return { outcome: "conflict", code: "multiple_terminals", detail: "Multiple live terminals claim this member" };
    const terminal = matches[0];
    if (!this.owns(terminal, member) || !isProviderArgv(terminal.argv, providerFor(member), this.binOf(member)) || terminal.cwd !== member.cwd ||
      (member.sessionId && terminal.labels["iamceo.session"] && terminal.labels["iamceo.session"] !== member.sessionId)) return { outcome: "conflict", code: "ownership_changed", detail: "Core terminal ownership, provider, cwd or generation changed" };
    const current = this.tracks.get(member.id);
    const sessionId = terminal.labels["iamceo.session"] || member.sessionId || (current?.terminal.address === terminal.address ? current.sessionId : null);
    const track = current && current.terminal.address === terminal.address && current.member.sessionGeneration === member.sessionGeneration ? current : await this.bind(member, terminal, sessionId);
    if (track === current) await this.refresh(track);
    this.unknownStarts.delete(member.id);
    return { outcome: "rejoined", started: { sessionId: track.sessionId, paneId: terminal.address, rejoined: true, identity: this.identity(track) } };
  }
  private async observe(track: Track, terminal: CoreTerminal, initial = false): Promise<void> {
    this.validateTrack(track);
    const previous = track.terminal;
    if (terminal.turn !== undefined && (!Number.isSafeInteger(terminal.turn) || terminal.turn < 0)) throw new CoreError("protocol", "Invalid core turn counter");
    if (terminal.address !== previous.address || (previous.pid && terminal.pid && previous.pid !== terminal.pid)) throw new CoreError("conflict", "Core terminal process identity changed");
    if ((terminal.turn ?? 0) < (previous.turn ?? 0)) throw new CoreError("stale", "Discarded older core turn");
    track.terminal = terminal;
    track.observedAt = new Date().toISOString();
    const state = terminal.status?.state;
    const status = terminal.state !== "live" ? "gone" : state === "working" ? "working" : ["idle", "done", "error"].includes(state || "") ? "idle" : "blocked";
    if (!initial && (terminal.turn !== previous.turn || state !== previous.status?.state)) this.bump(track);
    if (status === "gone" && laterNativeId(providerFor(track.member)) && !track.sessionId) this.lostCodex.set(track.member.id, track.member.sessionGeneration);
    // A completed foreground turn may still own regression shells/monitors.
    // Publish this before turn_end so reporting and settle keep that wait intact.
    await this.reportBackground(track, status);
    if (initial && state === "error" && !track.compact) {
      track.lastError = terminal.status?.msg || "CLI reported an error";
      this.event(track, { type: "turn_end", memberId: track.member.id, finalText: "", isError: true, errorText: track.lastError });
    }
    // A compact OSC turn belongs exclusively to its control operation.
    if (track.compact && !["failed", "succeeded"].includes(track.compact.phase)) { await this.checkCompact(track); track.endedTurn = Math.max(track.endedTurn, terminal.turn ?? 0); }
    else if (!initial && ["idle", "done", "error"].includes(state || "") && (terminal.turn ?? 0) > track.endedTurn) {
      track.completing = true;
      try { if (!this.manualLease(track.member.id)) await this.reportContext(track); } finally { track.completing = false; }
      this.validateTrack(track);
      track.endedTurn = terminal.turn ?? track.endedTurn;
      track.pending = false;
      // An idle report never clears an unresolved external write fence.
      track.lastError = state === "error" ? terminal.status?.msg || "CLI reported an error" : null;
      this.event(track, { type: "turn_end", memberId: track.member.id, finalText: "", isError: state === "error", ...(state === "error" ? { errorText: track.lastError! } : {}) });
    }
    if (status === "gone") track.pending = false;
    const setup = status === "blocked" ? await this.readSetup(track) : null;
    track.setupError = setup ? { code: "folder_trust", note: `폴더 신뢰 확인 창에서 멈췄습니다: ${track.member.cwd}` } : null;
    const blockedReason = setup ? "setup" : state === "blocked" ? (["permission", "selection", "setup"].includes(terminal.status?.kind || "") ? terminal.status!.kind as "permission" | "selection" | "setup" : "status_unknown") : status === "blocked" ? "status_unknown" : null;
    const statusKey = JSON.stringify([status, blockedReason, setup?.prompt.fingerprint ?? null]);
    if (status === "blocked" && track.status !== "blocked") track.promptSeq++;
    if (statusKey !== track.statusKey || track.failure) {
      track.status = status;
      track.statusKey = statusKey;
      if (state === "error" && status !== "gone") return; // Keep the error result from being overwritten by idle in the same observation.
      this.event(track, { type: "status", memberId: track.member.id, status, blockedReason, observation: { source: "core", observedAt: track.observedAt, freshness: "fresh", ownership: "verified", consecutiveFailures: 0, error: track.setupError }, ...(status === "gone" ? { exit: { reason: terminal.reason ?? null, exitCode: terminal.exit_code ?? null } } : {}) });
    }
  }
  /** Screen evidence only describes background work; OSC still owns input/slot admission. */
  private async reportBackground(track: Track, status: string): Promise<void> {
    if (providerFor(track.member) !== "claude" || this.manualLease(track.member.id)) return;
    let label: string | null = null;
    if (status === "idle") {
      try {
        const screen = await this.call<{ text: string; complete?: boolean }>("terminal.read", { terminal: track.terminal.address, lines: 0 });
        this.validateTrack(track);
        if (screen.complete === false || inputText(screen.text) === null) return;
        label = backgroundWait(screen.text);
      } catch { return; } // An unreadable footer cannot prove earlier work finished.
    }
    if (label === track.background) return;
    track.background = label;
    this.event(track, { type: "background", memberId: track.member.id, label });
  }
  /** 턴 끝 실측 창·사용량. core 는 문맥 표시만 하고 자동 압축은 하지 않는다. */
  private async reportContext(track: Track): Promise<void> {
    const sessionId = track.sessionId || track.member.sessionId;
    if (!sessionId) return;
    const endedAt = Date.now();
    const turn = track.terminal.turn;
    if (providerFor(track.member) === "antigravity") {
      const path = this.logPath(track);
      const tokens = path ? readAntigravityContext(this.providerHome(track.member), path) : null;
      // The status line record (session_id = conversation id) carries agy's own window and %; transcript tokens are the fallback.
      const captured = await capturedContext(this.options.contextHome, sessionId, { tokens: null, shownPct: null, model: track.member.model }, endedAt);
      const reading = { ...captured, tokens: captured.tokens ?? tokens };
      if (this.closed || this.tracks.get(track.member.id) !== track || (track.sessionId || track.member.sessionId) !== sessionId || track.terminal.turn !== turn) return;
      if (reading.tokens === null && !reading.exact) return;
      this.event(track, { type: "context_usage", memberId: track.member.id, sessionId, ...reading });
      return;
    }
    if (providerFor(track.member) === "codex") {
      const path = this.logPath(track);
      const reading = path ? readCodexContextFile(this.providerHome(track.member), path, sessionId).reading : null;
      if (reading) this.event(track, { type: "context_usage", memberId: track.member.id, ...reading, model: reading.model ?? track.member.model });
      return;
    }
    let tokens: number | null = null;
    let model: string | null = null;
    try {
      const path = findSessionFile(this.options.claudeHome ?? defaultClaudeHome(), track.member.cwd, sessionId);
      const tail = path ? readTranscriptTail(path) : null;
      tokens = tail?.contextTokens ?? null;
      model = tail?.model ?? null;
    } catch { /* unreadable transcript: the screen may still show the % */ }
    const screen = await this.call<{ text: string }>("terminal.read", { terminal: track.terminal.address, lines: 0 }, Math.min(this.rpcTimeoutMs, 1900)).then((r) => r.text, () => "");
    if (this.closed || this.tracks.get(track.member.id) !== track) return;
    const shownPct = screenContextPct(screen);
    const reading = await capturedContext(this.options.contextHome, sessionId, { tokens, shownPct, model: track.member.model ?? model }, endedAt);
    if (this.closed || this.tracks.get(track.member.id) !== track || (track.sessionId || track.member.sessionId) !== sessionId || track.terminal.turn !== turn) return;
    if (reading.tokens === null && reading.shownPct === null && !reading.exact) return;
    this.event(track, { type: "context_usage", memberId: track.member.id, sessionId, ...reading });
  }
  private refresh(track: Track): Promise<CoreTerminal> {
    if (track.refresh) return track.refresh;
    const pending = (async () => {
      try {
        const terminal = await this.call<CoreTerminal>("terminal.get", { terminal: track.terminal.address });
        this.validateTrack(track);
        if (!this.owns(terminal, track.member) || !isProviderArgv(terminal.argv, providerFor(track.member), this.binOf(track.member)) || terminal.cwd !== track.member.cwd) throw new CoreError("conflict", "Core terminal ownership changed");
        if (!this.manualLease(track.member.id)) this.discoverBinding(track);
        await this.observe(track, terminal);
        track.failures = 0; track.failure = null;
        return track.terminal;
      } catch (error) {
        const previousFailure = track.failure;
        track.failures++; track.failure = error instanceof CoreError ? error.kind : "error";
        if (!this.closed && this.tracks.get(track.member.id) === track && previousFailure !== track.failure && track.failure !== "not_found") this.event(track, { type: "status", memberId: track.member.id, status: track.status as "working" | "idle" | "blocked" | "gone" || "blocked",
          observation: { source: "core", observedAt: track.observedAt, freshness: "stale", ownership: track.failure === "conflict" ? "conflict" : "unknown", consecutiveFailures: track.failures, error: { code: track.failure, note: "Core terminal observation failed; retry read-only inspection" } } });
        throw error;
      }
    })().finally(() => { if (track.refresh === pending) track.refresh = null; });
    track.refresh = pending;
    return pending;
  }
  observationState(memberId: string): { observedAt: string; failures: number; failure: string | null; lastError: string | null; identity: RunnerTerminalIdentity; inputEpoch: number; setupError: Track["setupError"]; turn: number | null; state: string | null } | null {
    const track = this.tracks.get(memberId);
    return track ? { observedAt: track.observedAt, failures: track.failures, failure: track.failure, lastError: track.lastError, identity: this.identity(track), inputEpoch: track.epoch, setupError: track.setupError,
      turn: track.terminal.state === "live" ? track.terminal.turn ?? null : null, state: track.terminal.state === "live" ? track.terminal.status?.state ?? null : null } : null;
  }
  private async poll(): Promise<void> {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      await Promise.all([...this.tracks.values()].map(async (track) => {
        try { await this.refresh(track); }
        catch (error) {
          // A socket outage is not proof a holder died. Reconnect next poll.
          if (this.tracks.get(track.member.id) === track && error instanceof CoreError && error.kind === "not_found") {
            await this.observe(track, { ...track.terminal, state: "finished", reason: "not_found" });
          }
        }
      }));
    } finally { this.polling = false; }
  }
  isBusy(memberId: string): boolean {
    const track = this.tracks.get(memberId);
    return !!track && (track.pending || track.uncertain || track.completing || track.status === "working" || !!track.compact && !["failed", "succeeded"].includes(track.compact.phase));
  }
  occupiesTurnSlot(memberId: string): boolean {
    const track = this.tracks.get(memberId);
    if (!track) return false;
    const compacting = !!track.compact && !["failed", "succeeded"].includes(track.compact.phase);
    // Real 2026-11-07 run: one needs_owner delivery left its track "uncertain" while the CLI sat idle, and that
    // phantom turn halved maxConcurrentTurns=2 for every other member. Unknown input on an observed-idle CLI
    // stays fenced for delivery, but it is not a running turn.
    const observedQuiet = track.status === "idle"; // includes done; a blocked CLI may be paused mid-turn and still counts
    return track.pending || track.completing || track.status === "working" || compacting || (track.uncertain && !observedQuiet);
  }
  async send(member: RunnerMember, text: string, opts: StartOpts, _urgent = false): Promise<SendResult> {
    if (!cleanText(text).trim()) return unsupported("Message is empty");
    if (this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: "CLI configuration is being reloaded" };
    if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written", detail: "Manual terminal control is active" };
    if (this.sending.has(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
    this.sending.add(member.id);
    let track = this.tracks.get(member.id);
    let deliveryAttempted = false;
    try {
      if (!track) { await this.startLocked(member, opts); track = this.tracks.get(member.id)!; }
      this.assertMember(track, member);
      if (track.pending || track.uncertain || track.completing || track.compact && !["failed", "succeeded"].includes(track.compact.phase)) return { ok: false, reason: "busy", retryable: false, deliveryEffect: "not_written", detail: "A previous send is still running or delivery is uncertain; inspect the terminal" };
      const terminal = await this.refresh(track);
      if (terminal.state !== "live") return { ok: false, reason: "gone", retryable: false, deliveryEffect: "not_written" };
      const state = terminal.status?.state;
      if (state === "working") return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      if (state === "blocked") return { ok: false, reason: "blocked", retryable: true, deliveryEffect: "not_written", detail: `Complete the CLI dialog with iamceo attach ${member.id}` };
      if (!["idle", "done"].includes(state || "")) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: `No trustworthy idle OSC 7501 status; inspect CLI setup with iamceo attach ${member.id}` };
      const inputEpoch = track.epoch;
      const screen = await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 });
      // Never erase a person's draft or deliver through an unidentified dialog.
      // Status is taken exclusively from OSC7501, never this screen guard.
      const draft = composerDraft(providerFor(member), screen.text);
      if (draft !== "") return { ok: false, reason: "input_busy", retryable: false, deliveryEffect: "not_written", detail: draft === null ? "Cannot identify an empty CLI composer" : "A user draft is present; IAMCEO leaves it untouched" };
      const preference = member.parallel ?? this.parallelPreferences.get(member.id);
      const prefix = member.kind !== "conductor" && providerFor(member) !== "claude" && preference !== undefined
        ? (preference ? "IAMCEO execution preference: Use native subagents for independent parts of your assigned work when useful. Choose and coordinate them yourself within your existing tool permissions and approvals.\n\n" : "IAMCEO execution preference: Work sequentially for this task; do not spawn subagents.\n\n") : "";
      const binding = laterNativeId(providerFor(member)) && !track.sessionId && track.nonce ? codexBindingMarker(track.nonce) + "\n\n" : "";
      const cleaned = cleanText(binding + prefix + text);
      if (!cleaned.trim()) return unsupported("Message is empty");
      // Core generation 1 only permits if:idle|working. A done report has
      // no exact conditional; force:false still refuses any approval dialog.
      // IAMCEO manual controls use a lease; direct external attach cannot be
      // made atomic with this guard by the current core API.
      if (this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written", detail: "Manual terminal control is active" };
      const current = await this.refresh(track);
      this.validateTrack(track);
      if (current.state !== "live" || current.status?.state !== state || track.epoch !== inputEpoch) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      const result = await this.call<{ turn: number; started?: boolean | null }>("terminal.send", { terminal: terminal.address, text: cleaned, ...(state === "idle" ? { if: "idle" } : {}), force: false, wait: false }, this.sendTimeoutMs, () => {
        if (opts.beforeWrite?.() === false) return false;
        this.validateTrack(track!);
        track!.pending = true; this.bump(track!); deliveryAttempted = true;
        return true;
      });
      if (!Number.isSafeInteger(result.turn)) throw new CoreError("protocol", "Send reply has no valid turn counter", true);
      // started:false still means paste+Enter was delivered. Never resend it.
      await this.refresh(track).catch(() => undefined);
      return { ok: true, started: result.started ?? null, turn: result.turn };
    } catch (error) {
      if (error instanceof CoreError && error.kind === "admission") return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: error.message };
      if (track && deliveryAttempted && (!(error instanceof CoreError) || error.uncertain)) { track.pending = false; track.uncertain = true; return { ...unsupported(`Delivery may have occurred; do not resend automatically. ${error instanceof Error ? error.message : String(error)}`), deliveryEffect: "unknown" }; }
      if (track && deliveryAttempted) track.pending = false;
      if (error instanceof CoreError && ["blocked", "status_mismatch", "busy"].includes(error.kind)) return { ok: false, reason: error.kind === "blocked" ? "blocked" : "busy", retryable: true, detail: error.message, deliveryEffect: deliveryAttempted ? "rejected" : "not_written" };
      return { ok: false, reason: error instanceof CoreError && error.deliveryEffect === "not_written" ? "down" : "error", retryable: error instanceof CoreError && error.deliveryEffect === "not_written", deliveryEffect: !deliveryAttempted ? "not_written" : error instanceof CoreError ? error.deliveryEffect : "unknown", detail: error instanceof Error ? error.message : String(error) };
    } finally { this.sending.delete(member.id); }
  }

  private providerHome(member: RunnerMember): string {
    const provider = providerFor(member);
    if (provider === "antigravity") {
      if (!this.options.antigravityRoot) throw new CoreError("config", "Antigravity needs an IAMCEO-owned configuration root");
      return antigravityMemberHome(this.options.antigravityRoot, member.id);
    }
    return provider === "claude" ? this.options.claudeHome ?? defaultClaudeHome() : this.options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  }
  private binOf(member: RunnerMember): string | undefined {
    const provider = providerFor(member);
    return provider === "claude" ? this.options.claudeBin : provider === "codex" ? this.options.codexBin : this.options.antigravityBin;
  }
  private discoverBinding(track: Track): void {
    if (!laterNativeId(providerFor(track.member)) || track.sessionId || !track.nonce || track.member.sessionGeneration === undefined) return;
    if (providerFor(track.member) === "antigravity") {
      const found = discoverAntigravityConversation({ home: this.providerHome(track.member), nonce: track.nonce, marker: codexBindingMarker(track.nonce), since: track.bindingSince });
      if (found.outcome === "bound" && found.sessionId) {
        track.sessionId = found.sessionId;
        this.event(track, { type: "session", memberId: track.member.id, sessionId: found.sessionId });
      }
      return;
    }
    const result = discoverCodexSession({ home: this.providerHome(track.member), cwd: track.member.cwd, generation: track.member.sessionGeneration, nonce: track.nonce, since: track.bindingSince, cursor: track.binding });
    track.binding = result.cursor;
    if (result.outcome === "bound" && result.sessionId) {
      track.sessionId = result.sessionId;
      this.event(track, { type: "session", memberId: track.member.id, sessionId: result.sessionId });
    }
  }
  private logPath(track: Track): string | null {
    if (!track.sessionId) return null;
    const home = this.providerHome(track.member);
    if (providerFor(track.member) === "claude") return findSessionFile(home, track.member.cwd, track.sessionId);
    if (providerFor(track.member) === "antigravity") {
      return existingAntigravityTranscript(home, track.sessionId);
    }
    if (track.binding) {
      const matches = track.binding.files.filter((file) => file.matched && !file.invalid && file.meta?.sessionId === track.sessionId);
      if (matches.length === 1) return matches[0].path;
    }
    try {
      const matches = [...new Bun.Glob(`**/rollout-*-${track.sessionId}.jsonl`).scanSync({ cwd: join(home, "sessions"), absolute: true, onlyFiles: true, followSymlinks: false })].filter((path) => {
        const meta = parseCodexSessionMeta(readJsonlRange(join(home, "sessions"), path, null, { maxBytes: 1024 * 1024, maxRecords: 1 }).records[0]?.value);
        return meta?.sessionId === track.sessionId && meta.cwd === track.member.cwd;
      });
      return matches.length === 1 ? matches[0] : null;
    } catch { return null; }
  }
  async inspectDelivery(member: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection> {
    const release = this.reserve(member.id);
    try { return await this.inspectLocked(member, query); } finally { release(); }
  }
  private async inspectLocked(member: RunnerMember, query: DeliveryProbe): Promise<DeliveryInspection> {
    const unknown = (code: string, finding: "unknown" | "wait" = "unknown"): DeliveryInspection => ({ evidence: [{ source: "transport", verdict: "unknown", location: "none", code, complete: false, checkedAt: new Date().toISOString() }], finding, receivedDeliveryIds: [], snapshot: null, quiescence: "unresolved" });
    const track = this.tracks.get(member.id);
    if (!track) return unknown("not_attached");
    this.assertMember(track, member);
    if (this.manualLease(member.id)) return unknown("manual_control", "wait"); // No provider record scan under lease.
    const terminal = await this.refresh(track);
    if (query.cli !== providerFor(member) || query.backend !== "core" || (!this.sameIdentity(query.identity, this.identity(track)) && (!query.identity.sessionId || query.identity.sessionId !== track.sessionId))) return unknown("identity_changed");
    const stored = this.deps.recoveryStore?.inputState(member.id).unresolvedDispatches ?? track.dispatches;
    const dispatch = stored.find((item) => item.dispatchId === query.dispatchId && item.wireSha256 === query.wireSha256);
    const barrier = dispatch && this.deps.quiescence?.(member.id, dispatch);
    const originalWrite = barrier?.originalWrite ?? (dispatch?.transportState === "accepted" ? "settled" : dispatch?.transportState === "rejected" ? "rejected" : "unresolved");
    const externalInput = barrier?.externalInput ?? null;
    const inputEpoch = track.epoch;
    const screen = (await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 })).text;
    this.validateTrack(track);
    if (track.epoch !== inputEpoch) return unknown("input_epoch_changed");
    const draft = composerDraft(providerFor(member), screen);
    const composer = draft === null ? "unknown" : draft === "" ? "empty" : dispatch && exactComposer(screen, providerFor(member)) === dispatch.wireText ? "matches" : "different";
    const state = terminal.status?.state;
    const status = terminal.state !== "live" ? "gone" : ["idle", "done", "working", "blocked"].includes(state || "") ? state as "idle" | "done" | "working" | "blocked" : "unknown";
    const snapshot: NonNullable<DeliveryInspection["snapshot"]> = { identity: this.identity(track), observedAt: track.observedAt, turn: terminal.turn ?? null, inputEpoch: track.epoch, ownership: "verified", status,
      blockedReason: status === "blocked" ? terminal.status?.kind === "permission" ? "permission" : "status_unknown" : null,
      leaseActive: false, mutation: "none", composer, originalWrite, externalInput };
    const path = this.logPath(track);
    if (!path || !track.sessionId) return { ...unknown("session_unbound"), snapshot };
    const baseline = query.baseline.logs.find((log) => log.path === path);
    const read = readDeliveryEvidence({ cli: providerFor(member), home: this.providerHome(member), path, cwd: member.cwd, sessionId: track.sessionId,
      sessionGeneration: query.identity.sessionGeneration, markers: query.markers, bundleMarker: query.bundleMarker, baseline,
      since: baseline ? undefined : query.baseline.capturedAt, cursor: track.evidence.get(query.dispatchId) });
    if (read.cursor) track.evidence.set(query.dispatchId, read.cursor);
    const settled = originalWrite !== "unresolved";
    const allReceived = query.markers.length > 0 && query.markers.every((marker) => read.receivedDeliveryIds.includes(marker.deliveryId));
    const completeAbsence = read.evidence.complete && read.evidence.verdict === "absent";
    const finding = allReceived ? "received" : ["working", "blocked"].includes(status) ? "wait" : completeAbsence && settled && externalInput === false && composer === "matches" ? "draft_only" : completeAbsence && ["not_written", "rejected"].includes(originalWrite) && externalInput === false && composer === "empty" ? "not_received" : "unknown";
    return { evidence: [read.evidence, { source: "core_screen", verdict: composer === "unknown" ? "unknown" : "present", location: "composer", code: composer, complete: composer !== "unknown", checkedAt: new Date().toISOString() }], finding, receivedDeliveryIds: read.receivedDeliveryIds, snapshot, quiescence: settled ? "settled" : "unresolved" };
  }
  async repairDelivery(member: RunnerMember, request: DeliveryRepair, options?: RunnerWriteOptions): Promise<SendResult> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" }; }
    let attempted = false;
    const track = this.tracks.get(member.id);
    try {
      if (track?.compact && !["failed", "succeeded"].includes(track.compact.phase)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      if (!track || !this.deps.repair) return { ...unsupported("A durable delivery repair port and attached terminal are required"), deliveryEffect: "not_written" };
      const dispatch = this.deps.repair.load(member.id, request);
      if (!dispatch || dispatch.memberId !== member.id || dispatch.projectId !== member.projectId || dispatch.dispatchId !== request.dispatchId || createHash("sha256").update(dispatch.wireText).digest("hex") !== dispatch.wireSha256 || cleanText(dispatch.wireText) !== dispatch.wireText) return { ...unsupported("Stored delivery or reviewed recovery version changed"), deliveryEffect: "not_written" };
      const inspected = await this.inspectLocked(member, dispatch);
      const snapshot = inspected.snapshot;
      if (!snapshot || request.expectedSessionGeneration !== snapshot.identity.sessionGeneration || request.expectedSessionId !== snapshot.identity.sessionId || request.expectedTerminalId !== snapshot.identity.terminalId || request.expectedInputEpoch !== snapshot.inputEpoch || snapshot.externalInput !== false || snapshot.leaseActive || snapshot.status !== "idle") return { ok: false, reason: "input_busy", retryable: false, deliveryEffect: "not_written", detail: "Delivery identity, epoch or safe idle state changed" };
      if (inspected.receivedDeliveryIds.length) return { ...unsupported("User receipt already exists; reconcile delivery without input"), deliveryEffect: "not_written" };
      if (request.action === "resend" ? inspected.finding !== "not_received" : inspected.finding !== "draft_only" || !this.deps.submitKeyVerified || !this.methods.has("terminal.keys") || dispatch.submitAttempts !== 0) return { ...unsupported("No verified safe repair or submit-key barrier"), deliveryEffect: "not_written" };
      const final = await this.inspectLocked(member, dispatch);
      if (final.finding !== inspected.finding || final.receivedDeliveryIds.length || !final.snapshot || final.snapshot.status !== "idle" || final.snapshot.inputEpoch !== request.expectedInputEpoch || this.manualLease(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      const latest = track.terminal;
      // This port revalidates recovery version, source revisions and cancellation,
      // then commits the one write attempt in the same synchronous transaction.
      const beforeWrite = () => {
        if (options?.beforeWrite?.() === false) return false;
        if (!this.deps.repair!.prepare(member.id, request, dispatch)) throw new CoreError("admission", "Recovery version or source changed before repair", false, "not_written");
        this.validateTrack(track); this.bump(track); attempted = true; track.uncertain = true;
        return true;
      };
      if (request.action === "submit_only") {
        await this.call("terminal.keys", { terminal: latest.address, keys: ["enter"] }, this.sendTimeoutMs, beforeWrite);
        return { ...unsupported("Submit key was sent once; await user-record evidence before further input"), deliveryEffect: "unknown" };
      }
      const result = await this.call<{ turn: number; started?: boolean }>("terminal.send", { terminal: latest.address, text: dispatch.wireText, if: "idle", force: false, wait: false }, this.sendTimeoutMs, beforeWrite);
      if (!Number.isSafeInteger(result.turn)) throw new CoreError("protocol", "Invalid repair send receipt", true);
      track.pending = true;
      // The previous write was proved absent and this exact resend has a verified receipt.
      track.dispatches = track.dispatches.filter(item => item.dispatchId !== dispatch.dispatchId);
      track.uncertain = track.dispatches.length > 0;
      return { ok: true, turn: result.turn, started: result.started ?? null, receipt: { dispatchId: dispatch.dispatchId, receivedAt: new Date().toISOString(), source: "transport" } };
    } catch (error) {
      if (error instanceof CoreError && error.kind === "admission") return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: error.message };
      if (track && attempted) track.uncertain = true;
      return { ok: false, reason: "error", retryable: false, deliveryEffect: !attempted ? "not_written" : error instanceof CoreError ? error.deliveryEffect : "unknown", detail: error instanceof Error ? error.message : String(error) };
    } finally { release(); }
  }
  private saveCompact(track: Track, state: CoreCompactState): void {
    if (!this.deps.compactStore) throw new CoreError("unsupported", "Durable compact state port is required");
    this.deps.compactStore.save(track.member.id, state); track.compact = state;
  }
  async compact(member: RunnerMember, focus: string, opts: StartOpts): Promise<SendResult> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" }; }
    let attempted = false;
    const track = this.tracks.get(member.id);
    try {
      // agy 1.5.3 has no /compact command; it compacts on its own.
      if (providerFor(member) === "antigravity") return { ...unsupported("Antigravity CLI compacts its context automatically and has no /compact command"), deliveryEffect: "not_written" };
      if (!track || !track.sessionId || member.sessionGeneration === undefined || !this.deps.compactStore) return { ...unsupported("Compact requires an attached native session, generation and durable state port"), deliveryEffect: "not_written" };
      this.assertMember(track, member);
      if (this.manualLease(member.id) || this.isBusy(member.id)) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      const terminal = await this.refresh(track);
      // After any turn core reports "done" until the next input, so "idle only" meant a compact requested after the
      // first turn never ran and fenced the member's queue forever (real 2026-11-07 run). Use the same rule as a
      // normal delivery: idle is sent with the core-side if:"idle" guard, done after the same client-side checks.
      if (terminal.state !== "live" || !["idle", "done"].includes(terminal.status?.state || "")) return { ok: false, reason: "blocked", retryable: true, deliveryEffect: "not_written", detail: "Compact requires an idle or finished CLI" };
      const epoch = track.epoch;
      const screen = await this.screen(member);
      if ((composerDraft(providerFor(member), screen)) !== "") return { ok: false, reason: "input_busy", retryable: true, deliveryEffect: "not_written" };
      const path = this.logPath(track), home = this.providerHome(member);
      if (!path) return { ...unsupported("Native session log is unavailable"), deliveryEffect: "not_written" };
      const root = join(home, providerFor(member) === "claude" ? "projects" : "sessions");
      const baseline = compactLogBaseline(root, path);
      if (!baseline) return { ...unsupported("Compact log baseline is incomplete"), deliveryEffect: "not_written" };
      const current = await this.refresh(track);
      const currentState = current.status?.state;
      if (current.state !== "live" || !["idle", "done"].includes(currentState || "") || track.epoch !== epoch || this.manualLease(member.id) || !readJsonlRange(root, path, baseline, { maxBytes: 0 }).complete) return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written" };
      const command = providerFor(member) === "codex" ? "/compact" : `/compact ${cleanText(focus).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim()}`.trim();
      const result = await this.call<{ turn: number; started?: boolean }>("terminal.send", { terminal: current.address, text: command, ...(currentState === "idle" ? { if: "idle" } : {}), force: false, wait: false }, this.sendTimeoutMs, () => {
        if (opts.beforeWrite?.() === false) return false;
        this.validateTrack(track);
        this.saveCompact(track, { id: crypto.randomUUID(), phase: "sending", startedAt: Date.now(), cursor: null, baseline: { path, fileIdentity: baseline.fileIdentity, offset: baseline.offset,
          sessionId: track.sessionId!, terminalId: current.address, generation: member.sessionGeneration!, turn: current.turn ?? null, model: member.model } });
        this.bump(track); track.pending = true; attempted = true;
        return true;
      });
      if (!Number.isSafeInteger(result.turn)) throw new CoreError("protocol", "Invalid compact receipt", true);
      this.saveCompact(track, { ...track.compact!, phase: "running" });
      return { ok: true, started: result.started ?? null, turn: result.turn };
    } catch (error) {
      if (error instanceof CoreError && error.kind === "admission") return { ok: false, reason: "busy", retryable: true, deliveryEffect: "not_written", detail: error.message };
      if (track?.compact && attempted) {
        const uncertain = !(error instanceof CoreError) || error.uncertain;
        track.uncertain ||= uncertain;
        if (!uncertain) track.pending = false;
        const next: CoreCompactState = { ...track.compact, phase: uncertain ? "uncertain" : "failed" };
        track.compact = next; // Preserve in-memory fence even when persistence fails after input.
        try { this.saveCompact(track, next); } catch { track.uncertain = true; }
      }
      return { ok: false, reason: "error", retryable: false, deliveryEffect: !attempted ? "not_written" : error instanceof CoreError ? error.deliveryEffect : "unknown", detail: error instanceof Error ? error.message : String(error) };
    } finally { release(); }
  }
  private async checkCompact(track: Track): Promise<void> {
    let operation = track.compact!;
    const state = track.terminal.status?.state;
    const resolution = operation.manualResolution;
    if (operation.phase === "uncertain" && resolution && track.terminal.state === "live") {
      if (["working", "blocked"].includes(state || "") && !resolution.unsettled) {
        this.saveCompact(track, { ...operation, manualResolution: { ...resolution, unsettled: true } });
        operation = track.compact!;
      }
      if (["idle", "done"].includes(state || "") && (resolution.unsettled || resolution.turn !== null && (track.terminal.turn ?? -1) > resolution.turn)) {
        this.saveCompact(track, { ...operation, phase: "failed", reason: "user_resolved" });
        track.pending = false; track.uncertain = track.dispatches.length > 0;
        this.event(track, { type: "activity", memberId: track.member.id, kind: "system", text: "사용자 확인으로 압축 대기를 해제했습니다", runId: operation.id });
        return;
      }
    }
    if (this.manualLease(track.member.id) || operation.phase === "sending") return;
    const result = observeCompactBoundary({ cli: providerFor(track.member), home: this.providerHome(track.member), cwd: track.member.cwd, baseline: operation.baseline,
      current: { sessionId: track.sessionId!, generation: track.member.sessionGeneration ?? -1, terminalId: track.terminal.address, turn: track.terminal.turn ?? null, model: track.member.model },
      settled: track.terminal.state === "live" && ["idle", "done"].includes(state || ""), providerError: state === "error", cursor: operation.cursor });
    if (result.outcome === "succeeded") {
      this.saveCompact(track, { ...operation, cursor: result.cursor, phase: "succeeded" });
      track.pending = false; track.uncertain = track.dispatches.length > 0; track.endedTurn = Math.max(track.endedTurn, track.terminal.turn ?? 0);
      this.event(track, { type: "compacted", memberId: track.member.id, runId: operation.id });
      // Post-compact usage is collected by the next fresh provider sample; never emit 0%.
    } else if (state === "error") {
      this.saveCompact(track, { ...operation, cursor: result.cursor, phase: "failed" });
      track.pending = false; track.uncertain = track.dispatches.length > 0;
      track.lastError = track.terminal.status?.msg || "CLI reported a compact error";
      this.event(track, { type: "activity", memberId: track.member.id, kind: "error", text: "CLI reported that context compaction failed", runId: operation.id });
    } else if (Date.now() - operation.startedAt >= (this.deps.compactTimeoutMs ?? 600_000) || result.outcome === "unknown") {
      this.saveCompact(track, { ...operation, cursor: result.cursor, phase: "uncertain" }); track.uncertain = true;
    } else operation.cursor = result.cursor;
  }
  async setParallel(member: RunnerMember, on: boolean, opts: StartOpts): Promise<SendResult> {
    if (member.kind === "conductor") return unsupported("This role coordinates through IAMCEO and cannot start native subagents");
    if (providerFor(member) !== "claude") {
      // Codex and Antigravity have native subagents, not Claude's Ultracode switch. Its capability
      // stays enabled; this preference is added explicitly to each next task.
      this.parallelPreferences.set(member.id, on);
      return { ok: true };
    }
    const command = `/effort ultracode ${on ? "on" : "off"}`;
    const sent = await this.send(member, command, opts);
    if (!sent.ok) return sent;
    const deadline = Date.now() + 5000;
    const word = on ? "on" : "off";
    while (Date.now() < deadline && !this.closed) {
      const screen = await this.screen(member).catch(() => "");
      const index = screen.lastIndexOf(command);
      if (index >= 0 && screen.slice(index + command.length).split("\n").some((line) => new RegExp(`^\\W*ultracode ${word}\\b`, "i").test(line))) {
        const track = this.tracks.get(member.id);
        if (track) track.pending = false;
        return { ok: true };
      }
      await Bun.sleep(150);
    }
    return unsupported(`The command was delivered, but Ultracode ${word} was not confirmed; inspect the terminal before retrying`);
  }
  async applyConfig(member: RunnerMember, opts: StartOpts): Promise<SendResult> {
    const track = this.tracks.get(member.id);
    if (!track) return { ok: false, reason: "gone", retryable: false };
    if (this.manualLease(member.id)) return { ok: false, reason: "input_busy", retryable: true, detail: "Manual terminal control is active" };
    if (this.isBusy(member.id) || this.sending.has(member.id) || this.configuring.has(member.id)) return { ok: false, reason: "busy", retryable: true };
    const sessionId = track.sessionId || member.sessionId;
    if (!sessionId) return unsupported("Native session id is unknown; use the CLI /model menu or explicitly start a fresh session");
    const release = this.reserve(member.id);
    this.configuring.add(member.id);
    try {
      const terminal = await this.refresh(track);
      if (!["idle", "done"].includes(terminal.status?.state || "")) return { ok: false, reason: "blocked", retryable: true };
      const screen = await this.screen(member);
      const draft = composerDraft(providerFor(member), screen);
      if (draft !== "") return { ok: false, reason: "input_busy", retryable: false, detail: "Configuration reload requires an identifiable empty composer; the user draft is preserved" };
      const resumed = { ...member, sessionId, paneId: null };
      providerLaunch(resumed, { ...opts, resume: true }, this.options); // Validate before stopping.
      await this.stopLocked(member, { whileWorking: false });
      await this.startLocked(resumed, { ...opts, resume: true });
      return { ok: true };
    } catch (error) { return unsupported(error instanceof Error ? error.message : String(error)); }
    finally { this.configuring.delete(member.id); release(); }
  }
  private async owned(member: RunnerMember): Promise<CoreTerminal> {
    const track = this.tracks.get(member.id);
    if (track) { this.assertMember(track, member); return this.refresh(track); }
    const address = this.tracks.get(member.id)?.terminal.address || member.paneId;
    if (!address) throw new CoreError("not_found", "No core terminal for member");
    const terminal = await this.call<CoreTerminal>("terminal.get", { terminal: address });
    if (!this.owns(terminal, member)) throw new CoreError("conflict", "Refusing to control a core terminal without matching IAMCEO ownership labels");
    return terminal;
  }
  async interrupt(member: RunnerMember): Promise<void> {
    const release = this.reserve(member.id);
    try {
      const terminal = await this.owned(member);
      const track = this.tracks.get(member.id);
      if (track) this.bump(track);
      const result = await this.call<{ outcome: string }>("terminal.interrupt", { terminal: terminal.address, timeout: 3 }, 6000);
      if (!["stopped", "exited"].includes(result.outcome)) throw new CoreError("not_stopped", `CLI interrupt outcome: ${result.outcome}`);
      if (track?.compact) { this.saveCompact(track, { ...track.compact, phase: "failed" }); track.pending = false; track.uncertain = track.dispatches.length > 0; }
    } finally { release(); }
  }
  async checkStop(member: RunnerMember, opts: { whileWorking?: boolean; preservePrompt?: boolean } = {}): Promise<void> {
    if (member.origin === "adopted") throw new CoreError("unsupported", "Cannot close an adopted user terminal");
    if (this.manualLease(member.id)) throw new CoreError("input_busy", "Manual terminal control lease is active");
    const track = this.tracks.get(member.id);
    if (!opts.whileWorking && track && this.isBusy(member.id)) throw new CoreError("busy", "A turn or unresolved input is still active");
    const terminal = await this.owned(member);
    if (terminal.state !== "live") return;
    const state = terminal.status?.state;
    if (opts.preservePrompt && !["idle", "done", "working"].includes(state || "")) throw new CoreError("busy", "Native approval or unknown CLI state must be resolved by the owner");
    if (!opts.whileWorking && !["idle", "done"].includes(state || "")) throw new CoreError("busy", "Resolve the current CLI turn/dialog before changing its provider or configuration");
    if (["idle", "done"].includes(state || "")) {
      const screen = await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 });
      const draft = composerDraft(providerFor(member), screen.text);
      if (draft !== "") throw new CoreError("input_busy", "Cannot close a CLI with a user draft or unknown composer; the draft is preserved");
    }
  }
  async stop(member: RunnerMember, opts: { whileWorking?: boolean } = {}): Promise<void> {
    const release = this.reserve(member.id);
    try { await this.stopLocked(member, { whileWorking: opts.whileWorking ?? true }); } finally { release(); }
  }
  private async stopLocked(member: RunnerMember, opts: { whileWorking?: boolean }): Promise<void> {
    let terminal: CoreTerminal;
    try { await this.checkStop(member, opts); terminal = await this.owned(member); }
    catch (error) { if (error instanceof CoreError && error.kind === "not_found") { this.detachStopped(member); return; } throw error; }
    if (terminal.state === "live") {
      if (!opts.whileWorking && !["idle", "done"].includes(terminal.status?.state || "")) throw new CoreError("busy", "CLI state changed before stop");
      try {
        const result = await this.call<CoreTerminal>("terminal.kill", { terminal: terminal.address }, 15_000);
        if (result.state !== "finished") throw new CoreError("not_stopped", "Core did not confirm terminal termination");
      } catch (error) {
        if (!(error instanceof CoreError) || !error.uncertain) throw error;
        try { if ((await this.owned(member)).state !== "finished") throw error; }
        catch (inspection) { if (!(inspection instanceof CoreError) || inspection.kind !== "not_found") throw inspection; }
      }
    }
    this.detachStopped(member);
  }
  private detachStopped(member: RunnerMember): void {
    const lease = this.leases.get(member.id);
    if (lease) this.deps.recoveryStore?.removeLease(member.id, lease.claimId);
    this.leases.delete(member.id); this.parallelPreferences.delete(member.id);
    const track = this.tracks.get(member.id);
    if (track && laterNativeId(providerFor(member)) && !track.sessionId) this.lostCodex.set(member.id, member.sessionGeneration);
    this.tracks.delete(member.id);
    if (track) this.event(track, { type: "status", memberId: member.id, status: "gone" });
  }
  async screen(member: RunnerMember): Promise<string> {
    const terminal = await this.owned(member);
    return (await this.call<{ text: string }>("terminal.read", { terminal: terminal.address, lines: 0 })).text;
  }
  async terminalInfo(member: RunnerMember): Promise<{ cols: number; rows: number }> {
    const terminal = await this.owned(member);
    if (terminal.address !== member.paneId) throw new CoreError("conflict", "터미널 연결이 바뀌었습니다");
    if (terminal.state !== "live") throw new CoreError("finished", "터미널이 끝났습니다");
    if (!Number.isInteger(terminal.cols) || !Number.isInteger(terminal.rows) || terminal.cols! < 1 || terminal.rows! < 1) {
      throw new CoreError("unsupported", "터미널 크기를 확인할 수 없습니다");
    }
    return { cols: terminal.cols!, rows: terminal.rows! };
  }
  terminalLease(memberId: string): TerminalLease | null { return this.manualLease(memberId); }
  renewLease(memberId: string, leaseId: string): number {
    const lease = this.manualLease(memberId);
    if (!lease || lease.leaseId !== leaseId) throw new CoreError("conflict", "조작권이 없습니다");
    const next = { ...lease, expiresAt: Date.now() + 5 * 60_000 };
    this.deps.recoveryStore?.saveLease(next);
    this.leases.set(memberId, next);
    return next.expiresAt;
  }
  async noteTerminalInput(memberId: string, write: () => void): Promise<void> {
    const track = this.tracks.get(memberId);
    if (!track) throw new CoreError("not_found", "Terminal is no longer tracked");
    const terminal = track.terminal;
    this.bump(track);
    const compact = this.disarmManualResolution(track);
    write(); // A successful local PTY write is the stream's acknowledgement.
    await track.refresh?.catch(() => undefined);
    this.validateTrack(track);
    this.armManualResolution(track, compact, terminal);
    await this.refresh(track).catch(() => undefined);
  }
  private disarmManualResolution(track: Track) {
    const compact = track.compact && ["running", "uncertain"].includes(track.compact.phase) ? track.compact : null;
    if (compact?.manualResolution) this.saveCompact(track, { ...compact, manualResolution: undefined });
    return compact;
  }
  private armManualResolution(track: Track, compact: Track["compact"], terminal: CoreTerminal): void {
    if (compact && track.compact?.id === compact.id && ["running", "uncertain"].includes(track.compact.phase)) this.saveCompact(track, { ...track.compact,
      manualResolution: { turn: terminal.turn ?? null, unsettled: ["working", "blocked"].includes(terminal.status?.state || "") } });
  }
  private async readSetup(track: Track): Promise<ReturnType<typeof claudeFolderTrust>> {
    if (track.terminal.state !== "live" || ["working", "idle", "done", "error"].includes(track.terminal.status?.state || "")) return null;
    const epoch = track.epoch;
    const screen = await this.call<{ text: string }>("terminal.read", { terminal: track.terminal.address, lines: 0 });
    this.validateTrack(track);
    return epoch === track.epoch ? folderTrust(providerFor(track.member))(screen.text, track.member.cwd) : null;
  }
  async approval(member: RunnerMember): Promise<ApprovalPrompt | null> {
    const track = this.tracks.get(member.id);
    if (!track) return null;
    this.assertMember(track, member);
    await this.refresh(track);
    const setup = await this.readSetup(track);
    return setup && setup.prompt.fingerprint !== track.setupAttempted ? setup.prompt : null;
  }
  /** 막힌 칸의 질문·선택·승인 창. 막힘이 아니면 null. 읽지 못하면 limited(원문만). */
  private async readPrompt(track: Track): Promise<{ prompt: NativePrompt; key: string; observedAt: string } | null> {
    if (track.terminal.state !== "live" || track.status !== "blocked") return null;
    const provider = providerFor(track.member);
    const epoch = track.epoch;
    const setup = await this.readSetup(track);
    let prompt: NativePrompt;
    if (setup && setup.prompt.fingerprint !== track.setupAttempted) {
      prompt = { ...setup.prompt, kind: "setup", provider, selected: setup.selected, limited: false, raw: "" };
    } else {
      const screen = await this.call<{ text: string }>("terminal.read", { terminal: track.terminal.address, lines: 0 });
      this.validateTrack(track);
      prompt = parseNativePrompt(screen.text, provider) ?? limitedPrompt(provider, screen.text, "창 모양을 읽지 못했습니다");
    }
    if (epoch !== track.epoch) return null;
    const key = `${this.boot}:${track.member.sessionGeneration ?? 0}:${track.terminal.turn ?? 0}:${track.promptSeq}:${prompt.fingerprint}`;
    if (track.promptSeen?.key !== key) track.promptSeen = { key, at: new Date().toISOString() };
    return { prompt, key, observedAt: track.promptSeen.at };
  }
  async nativePrompt(member: RunnerMember): Promise<{ prompt: NativePrompt; promptKey: string; observedAt: string; answered?: boolean } | null> {
    const track = this.tracks.get(member.id);
    if (!track) return null;
    this.assertMember(track, member);
    await this.refresh(track);
    const read = await this.readPrompt(track);
    if (!read) return null;
    return { prompt: read.prompt, promptKey: read.key, observedAt: read.observedAt, ...(track.answeredPrompts.includes(read.key) ? { answered: true } : {}) };
  }
  /**
   * 넣은 뒤 창을 다시 읽어 터미널이 받았는지 본다. 창이 닫히거나 다른 창이면 accepted, 시간 안에 그대로면 unconfirmed.
   * 어느 쪽이든 다시 넣지 않는다(울타리는 넣기 전에 쳤다). 읽기 오류는 확인하지 못한 것으로 둔다.
   */
  private async checkAccepted(track: Track, promptKey: string): Promise<{ terminal: "accepted" | "unconfirmed"; after: "working" | "blocked" | "idle" | "gone" | null }> {
    const deadline = Date.now() + (this.deps.acceptCheckMs ?? 1200);
    let after: "working" | "blocked" | "idle" | "gone" | null = null;
    for (;;) {
      try {
        await this.refresh(track);
        if (this.tracks.get(track.member.id) !== track) return { terminal: "unconfirmed", after: null };
        after = track.terminal.state !== "live" || track.status === "gone" ? "gone" : track.status === "working" ? "working" : track.status === "blocked" ? "blocked" : "idle";
        if (after !== "blocked") return { terminal: "accepted", after };
        const read = await this.readPrompt(track);
        if (!read || read.key !== promptKey) return { terminal: "accepted", after };
      } catch { /* 시간 안에 다시 본다 */ }
      const left = deadline - Date.now();
      if (left <= 0) return { terminal: "unconfirmed", after };
      await Bun.sleep(Math.min(150, left));
    }
  }
  /**
   * 대표가 고른 선택지(자유 응답이면 그 글)를 지금 창에 한 번 넣는다. 누르기 직전에 창을 다시 읽어 promptKey 가 같을 때만,
   * 조작권·세대·입력 순번을 다시 확인하고 넣는다. 화살표로 그 줄로 옮긴 뒤 Enter 한 번(자유 응답은 글 붙여넣기+Enter 한 번).
   */
  async answerNativePrompt(member: RunnerMember, promptKey: string, option: number, text?: string): Promise<NativePromptAnswer> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, reason: "input_busy" }; }
    const track = this.tracks.get(member.id);
    let attempted = false;
    try {
      if (!track) return { ok: false, reason: "gone" };
      this.assertMember(track, member);
      if (this.manualLease(member.id)) return { ok: false, reason: "leased" };
      if (track.uncertain || track.compact && !["failed", "succeeded"].includes(track.compact.phase)) return { ok: false, reason: "input_busy" };
      if (!this.methods.has("terminal.keys")) return { ok: false, reason: "unrecognized" };
      if (track.answeredPrompts.includes(promptKey)) return { ok: false, reason: "already" };
      const identity = this.identity(track);
      await this.refresh(track);
      if (track.terminal.state !== "live") return { ok: false, reason: "gone" };
      const epoch = track.epoch;
      const read = await this.readPrompt(track);
      if (!read) return { ok: false, reason: "not_blocked" };
      if (read.key !== promptKey) return { ok: false, reason: "changed", current: read.prompt };
      if (read.prompt.limited) return { ok: false, reason: "unrecognized", current: read.prompt };
      const index = read.prompt.options.findIndex((o) => o.n === option);
      const chosen = read.prompt.options[index];
      if (!chosen) return { ok: false, reason: "no_option", current: read.prompt };
      if (text !== undefined && !chosen.freeText) return { ok: false, reason: "no_option", current: read.prompt };
      if (chosen.freeText && text === undefined) return { ok: false, reason: "needs_text", current: read.prompt };
      const clean = text === undefined ? undefined : cleanText(text).trim();
      if (text !== undefined && !clean) return { ok: false, reason: "needs_text", current: read.prompt };
      // 읽은 뒤 조작권·세대·관측이 바뀌었으면 넣지 않는다.
      await this.refresh(track);
      this.validateTrack(track);
      if (this.manualLease(member.id)) return { ok: false, reason: "leased" };
      if (track.epoch !== epoch || !this.sameIdentity(identity, this.identity(track))) return { ok: false, reason: "input_busy" };
      const distance = index - read.prompt.selected;
      const arrows: string[] = Array(Math.abs(distance)).fill(distance < 0 ? "up" : "down");
      // 넣기 전에 울타리를 친다. 응답이 모호해도 같은 창에 다시 넣지 않는다.
      track.answeredPrompts = [...track.answeredPrompts.slice(-19), promptKey];
      if (read.prompt.kind === "setup") track.setupAttempted = read.prompt.fingerprint;
      this.bump(track); attempted = true;
      if (clean !== undefined) {
        if (arrows.length) await this.call("terminal.keys", { terminal: track.terminal.address, keys: arrows }, this.sendTimeoutMs);
        await this.call("terminal.send", { terminal: track.terminal.address, text: clean, force: true, wait: false }, this.sendTimeoutMs);
      } else {
        await this.call("terminal.keys", { terminal: track.terminal.address, keys: [...arrows, "enter"] }, this.sendTimeoutMs);
      }
      return { ok: true, prompt: read.prompt, chosen, ...(await this.checkAccepted(track, promptKey)) };
    } catch (error) {
      if (track && attempted && (!(error instanceof CoreError) || error.uncertain)) track.uncertain = true;
      if (!attempted && error instanceof CoreError && error.kind === "not_found") return { ok: false, reason: "gone" };
      if (!attempted && error instanceof CoreError && error.kind === "conflict") return { ok: false, reason: "changed" };
      throw error;
    } finally { release(); }
  }
  async answerApproval(member: RunnerMember, fingerprint: string, option: number): Promise<import("./types.ts").ApprovalAnswer> {
    let release: () => void;
    try { release = this.reserve(member.id); } catch { return { ok: false, reason: "input_busy" }; }
    const track = this.tracks.get(member.id);
    let attempted = false;
    try {
      if (!track) return { ok: false, reason: "gone" };
      this.assertMember(track, member);
      if (this.manualLease(member.id) || track.uncertain || track.compact && !["failed", "succeeded"].includes(track.compact.phase)) return { ok: false, reason: "input_busy" };
      if (!this.methods.has("terminal.keys")) return { ok: false, reason: "unrecognized" };
      const identity = this.identity(track);
      const epoch = track.epoch;
      await this.refresh(track);
      if (track.terminal.state !== "live") return { ok: false, reason: "gone" };
      const setup = await this.readSetup(track);
      if (!setup) return { ok: false, reason: "unrecognized" };
      const current = setup.prompt;
      if (fingerprint !== current.fingerprint || track.setupAttempted === fingerprint) return { ok: false, reason: "changed", current };
      const chosen = current.options.find((item) => item.n === option);
      if (!chosen) return { ok: false, reason: "no_option", current };
      // Revalidate identity/status after the screen read. No input crosses a lease or epoch change.
      await this.refresh(track);
      this.validateTrack(track);
      if (this.manualLease(member.id) || track.epoch !== epoch || !this.sameIdentity(identity, this.identity(track))) return { ok: false, reason: "input_busy" };
      const final = await this.readSetup(track);
      if (!final || final.prompt.fingerprint !== fingerprint || track.epoch !== epoch) return { ok: false, reason: "changed", current: final?.prompt ?? null };
      const distance = option - 1 - final.selected;
      const keys = [...Array(Math.abs(distance)).fill(distance < 0 ? "up" : "down"), "enter"];
      // Fence before the single write, including ambiguous replies. Never replay a setup answer.
      track.setupAttempted = fingerprint; this.bump(track); attempted = true;
      await this.call("terminal.keys", { terminal: track.terminal.address, keys }, this.sendTimeoutMs);
      await this.refresh(track).catch(() => undefined); // Exit after 'No' is an observed exit, never a successful work turn.
      return { ok: true, prompt: current, chosen };
    } catch (error) {
      if (track && attempted && (!(error instanceof CoreError) || error.uncertain)) track.uncertain = true;
      if (!attempted && error instanceof CoreError && error.kind === "not_found") return { ok: false, reason: "gone" };
      if (!attempted && error instanceof CoreError && error.kind === "conflict") return { ok: false, reason: "changed" };
      throw error;
    } finally { release(); }
  }
  private manualLease(memberId: string): TerminalLease | null {
    const lease = this.leases.get(memberId);
    if (lease && this.deps.recoveryStore) {
      const saved = this.deps.recoveryStore.inputState(memberId).lease;
      if (!saved || saved.leaseId !== lease.leaseId || !this.sameIdentity(saved.identity, lease.identity)) {
        this.deps.recoveryStore.removeLease(memberId, lease.claimId);
        this.leases.delete(memberId);
        return null;
      }
      if (saved.expiresAt > Date.now()) { this.leases.set(memberId, saved); return saved; }
    }
    if (lease && lease.expiresAt > Date.now()) return lease;
    if (lease) this.deps.recoveryStore?.removeLease(memberId, lease.claimId);
    this.leases.delete(memberId);
    return null;
  }
  async terminalControl(member: RunnerMember, action: TerminalControlAction): Promise<TerminalControlResult> {
    const release = this.reserve(member.id);
    try {
      const lease = this.manualLease(member.id);
      // Revoking our own lease is local: terminal.get may already be not_found.
      if (action.action === "release") {
        const track = this.tracks.get(member.id);
        if (track) this.assertMember(track, member);
        if (!lease || action.leaseId !== lease.leaseId || lease.identity.sessionGeneration !== (member.sessionGeneration ?? -1) ||
            lease.identity.terminalId !== (member.paneId ?? track?.terminal.address)) throw new CoreError("conflict", "A matching active terminal control lease is required");
        this.deps.recoveryStore?.removeLease(member.id, lease.claimId); this.leases.delete(member.id);
        if (track) this.bump(track);
        return {};
      }
      const terminal = await this.owned(member);
      const track = this.tracks.get(member.id);
      if (!track) throw new CoreError("not_found", "Reattach the owned terminal before claiming control");
      if (action.action === "claim") {
        if (lease && action.leaseId !== lease.leaseId && action.leaseId !== lease.claimId) throw new CoreError("conflict", "Another terminal control lease is active");
        // Expired rows can also survive a restart, when there is no cached
        // lease left for manualLease to remove. Only clear this claim's row
        // after the store confirms there is no live holder.
        if (!lease && action.leaseId && this.deps.recoveryStore && !this.deps.recoveryStore.inputState(member.id).lease) {
          this.deps.recoveryStore.removeLease(member.id, action.leaseId);
        }
        const claimId = lease?.claimId || action.leaseId || crypto.randomUUID();
        // A claim is retry-stable; each new acquisition has a distinct incarnation.
        const next: TerminalLease = { memberId: member.id, claimId, leaseId: lease?.leaseId || crypto.randomUUID(), identity: this.identity(track), expiresAt: Date.now() + 5 * 60_000, lastInputSequence: lease?.lastInputSequence ?? 0 };
        this.deps.recoveryStore?.saveLease(next); this.leases.set(member.id, next); this.bump(track);
        return { leaseId: next.leaseId, expiresAt: next.expiresAt };
      }
      if (!lease || action.leaseId !== lease.leaseId) throw new CoreError("conflict", "A matching active terminal control lease is required");
      if (terminal.state !== "live") throw new CoreError("finished", "Terminal has finished");
      if (action.action === "input" && (!action.text?.length || Buffer.byteLength(action.text) > 128 * 1024)) throw new CoreError("invalid_params", "Terminal input must contain 1–131072 bytes");
      if (action.action === "key" && !this.methods.has("terminal.keys")) throw new CoreError("unsupported", "Core does not support terminal.keys");
      if (action.action === "key" && (!action.key || !["enter", "up", "down", "esc", "tab", "ctrl+c", "backspace"].includes(action.key))) throw new CoreError("invalid_params", "Unsupported terminal control key");
      const next = { ...lease, expiresAt: Date.now() + 5 * 60_000, lastInputSequence: lease.lastInputSequence + 1 };
      this.deps.recoveryStore?.saveLease(next); this.leases.set(member.id, next); this.bump(track);
      const compact = this.disarmManualResolution(track);
      try {
        if (action.action === "input") await this.call("terminal.send", { terminal: terminal.address, text: cleanText(action.text!), force: true, wait: false }, this.sendTimeoutMs);
        else await this.call("terminal.keys", { terminal: terminal.address, keys: [action.key] }, this.sendTimeoutMs);
      } catch (error) {
        if (!(error instanceof CoreError) || error.uncertain) track.uncertain = true;
        throw error;
      }
      // Drain any observation started before the ACK while resolution remains
      // disarmed. Only a newly requested observation may prove settled input.
      await track.refresh?.catch(() => undefined);
      this.validateTrack(track);
      this.armManualResolution(track, compact, terminal);
      // Re-observe after the ACK. Claim/release, elapsed time and unchanged idle
      // cannot prove that a human intervention settled this compact operation.
      await this.refresh(track).catch(() => undefined);
      return { leaseId: next.leaseId, expiresAt: next.expiresAt };
    } finally { release(); }
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.configuring.clear();
    this.parallelPreferences.clear();
    this.leases.clear();
    this.tracks.clear();
  }
}

/** No trimming or whitespace normalization for a submit-only full-wire comparison. */
const laterNativeId = (provider: CoreProvider) => provider !== "claude";
function composerDraft(provider: CoreProvider, screen: string): string | null {
  return provider === "claude" ? inputText(screen) : provider === "codex" ? codexDraft(screen) : antigravityDraft(screen);
}
function folderTrust(provider: CoreProvider) {
  return provider === "claude" ? claudeFolderTrust : provider === "codex" ? codexFolderTrust : antigravityFolderTrust;
}
function exactComposer(screen: string, provider: CoreProvider): string | null {
  if (/\x1b/.test(screen)) return null;
  if (provider === "antigravity") return antigravityExactComposer(screen);
  const lines = screen.split("\n");
  if (provider === "codex") {
    if (codexDraft(screen) === null) return null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = /^\s*› (.*)$/.exec(lines[i]);
      if (match) return match[1];
    }
    return null;
  }
  for (let bottom = lines.length - 1; bottom > 0; bottom--) {
    if (!/^[─━]{3,}$/.test(lines[bottom])) continue;
    let top = bottom - 1;
    while (top >= 0 && !/^[─━]{3,}$/.test(lines[top])) top--;
    if (top < 0) return null;
    const first = /^[❯>] (.*)$/.exec(lines[top + 1]);
    if (!first || lines.slice(top + 2, bottom).some(line => /[│┃]/.test(line))) return null;
    return [first[1], ...lines.slice(top + 2, bottom)].join("\n");
  }
  return null;
}

/** Input safety only. Unknown composer layouts refuse delivery. */
export function codexDraft(screen: string): string | null {
  const clean = screen.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = clean.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^\s*›(?: (.*))?$/.exec(lines[i]);
    if (!match) continue;
    // terminal.read is plain text: the current native Codex placeholder is
    // indistinguishable from someone typing that exact sentence. A manual
    // control lease suspends automation while a person uses this composer.
    const below = lines.slice(i + 1).filter((line) => line.trim());
    if (below.some((line) => !/^\s*(?:\? for shortcuts|← for agents · \? for shortcuts|\d+% context left|(?:GPT-|gpt-|o\d|codex)[^·]* · [/~]|\S+\s+\d+% context left)/i.test(line))) return null;
    const draft = match[1]?.trim() || "";
    return draft === "Ask Codex to do anything" ? "" : draft;
  }
  return null;
}


export { ensureCoreServer } from "../core-supervisor.ts";
