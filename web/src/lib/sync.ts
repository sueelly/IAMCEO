import type { SyncCursor, SyncSnapshot, WsEvent } from "@shared/types";

export interface SyncSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}
export interface RealtimeCapabilities { capabilities?: { browserRealtime?: boolean; realtime?: boolean; operations?: boolean } }
export interface SyncContext { projectId: string; signal: AbortSignal; isCurrent(): boolean }
interface Dependencies {
  capabilities(signal?: AbortSignal): Promise<RealtimeCapabilities>;
  realtimeSession(signal?: AbortSignal): Promise<void>;
  socket(protocol: 1 | 2): SyncSocket;
  readSnapshot(projectId: string, signal: AbortSignal): Promise<SyncSnapshot>;
  readLegacy(projectId: string, context: SyncContext): Promise<void>;
  onSnapshot(snapshot: SyncSnapshot, context: SyncContext): Promise<void> | void;
  onEvent(event: WsEvent): void;
  onError(error: unknown): void;
  onConnection(connection: "connecting" | "online" | "offline"): void;
  onCapabilities?(capabilities: RealtimeCapabilities | null): void;
  onInvalidate?(): void;
  now?(): number;
  setTimeout?(fn: () => void, ms: number): number;
  clearTimeout?(id: number): void;
}
const validCursor = (value: unknown): value is SyncCursor => {
  const c = value as SyncCursor | null;
  return !!c && typeof c.epoch === "string" && c.epoch.length > 0 && Number.isSafeInteger(c.seq) && c.seq >= 0;
};
const changeTypes = new Set(["projects", "project", "member", "member_removed", "decision", "todo", "work", "message", "file", "task", "activity", "settings", "herdr"]);
function validChange(frame: Record<string, unknown>): boolean {
  const entity = (name: string) => !!frame[name] && typeof frame[name] === "object";
  if (["project", "member", "decision", "todo", "message", "file", "task"].includes(String(frame.type))) {
    const row = frame[String(frame.type)] as { id?: unknown; projectId?: unknown } | undefined;
    return !!row && typeof row.id === "string" && (frame.type === "project" || typeof row.projectId === "string");
  }
  if (frame.type === "member_removed") return typeof frame.projectId === "string" && typeof frame.memberId === "string";
  if (frame.type === "projects") return Array.isArray(frame.projects);
  if (frame.type === "work") return typeof frame.projectId === "string" && Array.isArray(frame.work);
  if (frame.type === "activity") return typeof frame.projectId === "string" && entity("activity");
  return frame.type === "settings" ? entity("settings") : frame.type === "herdr" ? entity("herdr") : true;
}

/** One owner for all snapshot work, socket retries and foreground generations in a tab. */
export class BrowserSyncCoordinator {
  private wanted = false;
  private foreground = true;
  private projectId = "";
  private generation = 0;
  private mode: "unknown" | "legacy" | "v2" = "unknown";
  private syncSupported = false;
  private socket: SyncSocket | null = null;
  private connecting = false;
  private activation: Promise<void> | null = null;
  private discoveryAbort: AbortController | null = null;
  private connectAbort: AbortController | null = null;
  private socketHello = false;
  private received: SyncCursor | null = null;
  private applied: SyncCursor | null = null;
  private highWater = 0;
  private lastSeen = 0;
  private lastRead = -Infinity;
  private readAbort: AbortController | null = null;
  private flight: Promise<void> | null = null;
  private dirty = false;
  private readTimer: number | null = null;
  private retryTimer: number | null = null;
  private fallbackTimer: number | null = null;
  private staleTimer: number | null = null;
  private socketFailures = 0;
  private readFailures = 0;
  private readonly now: () => number;
  private readonly timer: (fn: () => void, ms: number) => number;
  private readonly clear: (id: number) => void;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.timer = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
    this.clear = deps.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  }
  get protocol(): 1 | 2 | null { return this.mode === "unknown" ? null : this.mode === "v2" ? 2 : 1; }
  get active(): boolean { return this.wanted && this.foreground; }
  get usesSnapshots(): boolean { return this.syncSupported; }

  async start(projectId: string): Promise<void> {
    this.cancelGeneration(); this.wanted = true; this.projectId = projectId;
    this.mode = "unknown"; this.syncSupported = false; this.applied = null; this.socketFailures = this.readFailures = 0;
    if (this.active) await this.activate();
  }
  stop(): void { this.wanted = false; this.cancelGeneration(); this.mode = "unknown"; this.syncSupported = false; this.applied = null; }
  suspend(): void { this.foreground = false; this.cancelGeneration(); }
  resume(): void {
    if (!this.wanted) { this.foreground = true; return; }
    this.foreground = true; this.cancelGeneration(); void this.activate();
  }
  select(projectId: string): void {
    if (projectId === this.projectId) return;
    this.projectId = projectId; this.cancelGeneration(); this.applied = null;
    if (this.active) void this.activate();
  }
  reconnect(): Promise<void> {
    if (!this.active) return Promise.resolve();
    this.cancelGeneration(); return this.activate();
  }
  invalidate(immediate = false): void {
    if (!this.active) return;
    this.dirty = true; this.deps.onInvalidate?.();
    if (this.flight || this.readTimer !== null) return;
    const delay = Math.max(immediate ? 0 : 250, 500 - (this.now() - this.lastRead));
    const generation = this.generation;
    this.readTimer = this.timer(() => {
      this.readTimer = null;
      if (this.current(generation)) void this.read();
    }, delay);
  }
  async refresh(): Promise<void> {
    if (!this.active) return;
    if (this.mode === "unknown") return this.activate();
    this.dirty = true;
    if (this.flight) { await this.flight.catch(() => {}); if (!this.active || !this.dirty) return; }
    const remaining = 500 - (this.now() - this.lastRead);
    if (remaining > 0) {
      // Explicit callers await the same scheduled reconciliation used by invalidations.
      await new Promise<void>((resolve) => {
        const generation = this.generation;
        this.waiters.add(resolve);
        this.invalidate(true);
        if (!this.current(generation)) { this.waiters.delete(resolve); resolve(); }
      });
      return;
    }
    await this.read();
  }
  /** Cursor continuations share the snapshot flight and foreground cancellation fence. */
  async readExtra(action: (context: SyncContext) => Promise<void>): Promise<void> {
    const generation = this.generation;
    while (this.flight) { await this.flight.catch(() => {}); if (!this.current(generation)) return; }
    if (!this.current(generation)) return;
    const abort = new AbortController(); this.readAbort = abort;
    const context = { projectId: this.projectId, signal: abort.signal, isCurrent: () => this.current(generation) && !abort.signal.aborted };
    const flight = (async () => {
      try { await action(context); }
      finally {
        if (this.current(generation)) {
          this.flight = null; this.readAbort = null;
          if (this.dirty) this.invalidate();
        }
      }
    })();
    this.flight = flight; await flight;
  }
  private waiters = new Set<() => void>();
  private settleWaiters(): void { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  private current(generation: number): boolean { return this.active && generation === this.generation; }
  private activate(): Promise<void> {
    if (this.activation) return this.activation;
    const generation = this.generation;
    const activation = this.activateGeneration().finally(() => { if (this.current(generation)) this.activation = null; });
    this.activation = activation; return activation;
  }
  private async activateGeneration(): Promise<void> {
    const generation = this.generation;
    if (!this.current(generation)) return;
    this.deps.onConnection("connecting");
    if (this.mode === "unknown") {
      try {
        let capabilities: RealtimeCapabilities | null;
        this.discoveryAbort = new AbortController();
        try { capabilities = await this.deps.capabilities(this.discoveryAbort.signal); }
        catch (error) { if ((error as { status?: number })?.status !== 404) throw error; capabilities = null; }
        if (!this.current(generation)) return;
        this.discoveryAbort = null;
        this.mode = capabilities?.capabilities?.browserRealtime === true ? "v2" : "legacy";
        this.syncSupported = this.mode === "v2" || capabilities?.capabilities?.realtime === true || capabilities?.capabilities?.operations === true;
        this.deps.onCapabilities?.(capabilities);
      } catch (error) {
        if (this.current(generation)) { this.deps.onError(error); this.readFailures++; this.fallback(); }
        return;
      }
    }
    void this.connect(); this.watchStale(); await this.refresh();
  }
  private async read(): Promise<void> {
    if (!this.active || this.flight) return this.flight ?? undefined;
    if (this.readTimer !== null) this.clear(this.readTimer);
    this.readTimer = null; this.dirty = false; this.lastRead = this.now();
    const generation = this.generation, projectId = this.projectId;
    const abort = new AbortController(); this.readAbort = abort;
    const context: SyncContext = { projectId, signal: abort.signal, isCurrent: () => this.current(generation) && !abort.signal.aborted };
    const flight = (async () => {
      try {
        if (this.syncSupported) {
          const snapshot = await this.deps.readSnapshot(projectId, abort.signal);
          if (!context.isCurrent()) return;
          if (snapshot.protocol !== 2 || !validCursor(snapshot.cursor) || snapshot.requestedProjectId !== projectId
            || !["ok", "not_found", "archived"].includes(snapshot.projectStatus)
            || snapshot.projectStatus === "ok" && snapshot.state?.project.id !== projectId
            || snapshot.projectStatus !== "ok" && snapshot.state !== null
            || this.mode === "v2" && this.socketHello && this.received?.epoch !== snapshot.cursor.epoch
            || this.applied?.epoch === snapshot.cursor.epoch && this.applied.seq > snapshot.cursor.seq) throw new Error("동기화 응답이 현재 프로젝트 또는 커서와 맞지 않습니다");
          await this.deps.onSnapshot(snapshot, context);
          if (!context.isCurrent()) return;
          this.applied = snapshot.cursor;
          if (this.received?.epoch === snapshot.cursor.epoch) this.received.seq = Math.max(this.received.seq, snapshot.cursor.seq);
          if (this.mode === "v2" && this.socketHello && this.highWater > snapshot.cursor.seq) this.dirty = true;
        } else await this.deps.readLegacy(projectId, context);
        if (!context.isCurrent()) return;
        this.readFailures = 0;
        this.deps.onConnection(this.socket && (this.mode === "legacy" || this.socketHello) ? "online" : "offline");
      } catch (error) {
        if (!context.isCurrent()) return;
        this.readFailures++; this.deps.onConnection("offline"); this.deps.onError(error);
      } finally {
        if (this.current(generation)) {
          this.flight = null; this.readAbort = null; this.settleWaiters();
          if (this.dirty) this.invalidate();
          this.fallback();
        }
      }
    })();
    this.flight = flight; await flight;
  }
  private async connect(): Promise<void> {
    if (!this.active || this.socket || this.connecting || this.mode === "unknown") return;
    const generation = this.generation; this.connecting = true;
    try {
      this.connectAbort = new AbortController();
      if (this.mode === "v2") await this.deps.realtimeSession(this.connectAbort.signal);
      if (!this.current(generation)) return;
      this.connectAbort = null;
      const socket = this.deps.socket(this.mode === "v2" ? 2 : 1);
      this.socket = socket; this.lastSeen = this.now(); this.socketHello = false; this.received = null;
      const valid = () => this.current(generation) && this.socket === socket;
      socket.onopen = () => { if (valid()) { this.lastSeen = this.now(); this.invalidate(true); } };
      socket.onmessage = (event) => {
        if (!valid() || typeof event.data !== "string") return;
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(event.data); } catch { this.socketFailed(); return; }
        if (!frame || typeof frame !== "object") { this.socketFailed(); return; }
        this.lastSeen = this.now();
        if (this.mode === "legacy") {
          if (frame.type === "hello") { this.socketHello = true; this.deps.onConnection("online"); this.invalidate(true); }
          else if (frame.type !== "ping" && changeTypes.has(String(frame.type))) {
            this.deps.onEvent(frame as unknown as WsEvent);
            if (this.syncSupported) this.invalidate();
          }
          return;
        }
        this.receive(frame);
      };
      socket.onclose = () => { if (valid()) this.socketFailed(); };
      socket.onerror = () => { if (valid()) this.socketFailed(); };
    } catch (error) {
      if (this.current(generation)) { this.deps.onError(error); this.socketFailed(); }
    } finally { if (this.current(generation)) this.connecting = false; }
  }
  private receive(frame: Record<string, unknown>): void {
    if (!validCursor(frame)) { this.socketFailed(); return; }
    if (frame.type === "hello") {
      if (frame.protocol !== 2 || frame.heartbeatMs !== 15000 || frame.staleAfterMs !== 45000) { this.socketFailed(); return; }
      this.received = { epoch: frame.epoch, seq: frame.seq }; this.highWater = frame.seq; this.socketHello = true;
      this.invalidate(true); return;
    }
    const previous = this.received;
    if (!this.socketHello || !previous || frame.epoch !== previous.epoch || frame.type === "ping" && frame.seq < previous.seq) { this.socketFailed(); return; }
    if (changeTypes.has(String(frame.type)) && !validChange(frame)) { this.socketFailed(); return; }
    if (frame.seq <= previous.seq) return;
    this.received = { epoch: frame.epoch, seq: frame.seq }; this.highWater = Math.max(this.highWater, frame.seq);
    if (frame.type !== "ping" && frame.seq === previous.seq + 1 && changeTypes.has(String(frame.type))) this.deps.onEvent(frame as unknown as WsEvent);
    this.invalidate();
  }
  private socketFailed(): void {
    const socket = this.socket; this.socket = null; this.socketHello = false; this.received = null;
    socket?.close();
    if (!this.active) return;
    this.deps.onConnection("offline"); this.invalidate(true); this.fallback();
    if (this.retryTimer !== null) return;
    const generation = this.generation, delay = Math.min(30000, 500 * 2 ** Math.min(this.socketFailures++, 6));
    this.retryTimer = this.timer(() => { this.retryTimer = null; if (this.current(generation)) void this.connect(); }, delay);
  }
  private fallback(): void {
    if (this.fallbackTimer !== null) this.clear(this.fallbackTimer);
    this.fallbackTimer = null;
    if (!this.active || !this.readFailures && this.socket && this.socketHello && !this.dirty) return;
    const generation = this.generation, delay = Math.min(30000, 3000 * 2 ** Math.min(Math.max(0, this.readFailures - 1), 4));
    this.fallbackTimer = this.timer(() => {
      this.fallbackTimer = null;
      if (!this.current(generation)) return;
      if (this.mode === "unknown") void this.activate(); else this.invalidate(true);
    }, delay);
  }
  private watchStale(): void {
    if (this.staleTimer !== null) return;
    const generation = this.generation;
    this.staleTimer = this.timer(() => {
      this.staleTimer = null;
      if (!this.current(generation)) return;
      if (this.socket && this.now() - this.lastSeen > 45000) this.socketFailed();
      this.watchStale();
    }, 5000);
  }
  private cancelGeneration(): void {
    this.generation++; this.readAbort?.abort(); this.readAbort = null; this.flight = null; this.dirty = false;
    this.discoveryAbort?.abort(); this.connectAbort?.abort(); this.discoveryAbort = this.connectAbort = null; this.activation = null;
    this.connecting = false; this.socketHello = false; this.received = null;
    for (const id of [this.readTimer, this.retryTimer, this.fallbackTimer, this.staleTimer]) if (id !== null) this.clear(id);
    this.readTimer = this.retryTimer = this.fallbackTimer = this.staleTimer = null;
    const socket = this.socket; this.socket = null; socket?.close(); this.settleWaiters();
  }
}
