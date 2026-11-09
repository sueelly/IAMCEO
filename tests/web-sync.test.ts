import { describe, expect, test } from "bun:test";
import type { SyncSnapshot } from "../shared/types";
import { BrowserSyncCoordinator, type SyncSocket } from "../web/src/lib/sync";

class Clock {
  now = 0;
  id = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.id; this.timers.set(id, { at: this.now + ms, fn }); return id; };
  clearTimeout = (id: number) => { this.timers.delete(id); };
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at; this.timers.delete(next[0]); next[1].fn(); await flush();
    }
    this.now = end; await flush();
  }
}
class Socket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close() { this.closed = true; this.onclose?.(); }
  frame(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const snapshot = (seq = 0, epoch = "e", project = "p") => ({
  protocol: 2, cursor: { epoch, seq }, requestedProjectId: project, projectStatus: "ok", bootstrap: {},
  state: { project: { id: project } }, revisions: { settings: 0, members: {}, todos: {} },
}) as SyncSnapshot;
const hello = (seq = 0, epoch = "e") => ({ type: "hello", protocol: 2, epoch, seq, heartbeatMs: 15000, staleAfterMs: 45000 });

function fixture(options: { legacy?: boolean; read?: (id: string, signal: AbortSignal) => Promise<SyncSnapshot> } = {}) {
  const clock = new Clock(), sockets: Socket[] = [], applied: SyncSnapshot[] = [], legacy: string[] = [], starts: number[] = [], errors: unknown[] = [];
  const coordinator = new BrowserSyncCoordinator({
    now: () => clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    capabilities: async () => ({ capabilities: { browserRealtime: !options.legacy } }),
    realtimeSession: async () => {},
    socket: () => { const s = new Socket(); sockets.push(s); return s; },
    readSnapshot: async (id, signal) => { starts.push(clock.now); return options.read ? options.read(id, signal) : snapshot(0, "e", id); },
    readLegacy: async (id) => { legacy.push(id); },
    onSnapshot: (s) => { applied.push(s); },
    onEvent: () => {}, onError: (e) => { errors.push(e); }, onConnection: () => {},
  });
  return { coordinator, clock, sockets, applied, legacy, starts, errors };
}

describe("browser synchronization coordinator", () => {
  test("coalesces bursts for 250ms and starts at most two snapshots a second", async () => {
    const f = fixture(); await f.coordinator.start("p"); await flush();
    expect(f.starts).toEqual([0]);
    for (let i = 0; i < 20; i++) f.coordinator.invalidate();
    await f.clock.advance(499); expect(f.starts).toEqual([0]);
    await f.clock.advance(1); expect(f.starts).toEqual([0, 500]);
    f.coordinator.invalidate(); await f.clock.advance(499); expect(f.starts).toHaveLength(2);
    await f.clock.advance(1); expect(f.starts).toEqual([0, 500, 1000]); f.coordinator.stop();
  });
  test("rapid foreground generations retain the per-tab snapshot rate limit", async () => {
    const f = fixture(); await f.coordinator.start("p"); await flush();
    f.coordinator.suspend(); f.coordinator.resume(); await flush();
    f.coordinator.suspend(); f.coordinator.resume(); await flush();
    expect(f.starts).toEqual([0]);
    await f.clock.advance(500); expect(f.starts).toEqual([0, 500]); f.coordinator.stop();
  });

  test("single flight preserves invalidations arriving during the read", async () => {
    let finish!: (value: SyncSnapshot) => void;
    const f = fixture({ read: () => new Promise((resolve) => { finish = resolve; }) });
    void f.coordinator.start("p"); await flush();
    f.coordinator.invalidate(); await f.clock.advance(2000); expect(f.starts).toHaveLength(1);
    finish(snapshot()); await flush(); await f.clock.advance(250); expect(f.starts).toHaveLength(2); f.coordinator.stop();
  });

  test("explicit refresh awaits its next reconciliation and cursor reads serialize behind snapshots", async () => {
    let finish!: (value: SyncSnapshot) => void;
    const f = fixture({ read: () => new Promise((resolve) => { finish = resolve; }) });
    void f.coordinator.start("p"); await flush();
    let extra = false, refreshed = false;
    const extraRead = f.coordinator.readExtra(async () => { extra = true; });
    expect(extra).toBe(false); finish(snapshot()); await flush(); await extraRead; expect(extra).toBe(true);
    const refresh = f.coordinator.refresh().then(() => { refreshed = true; });
    await f.clock.advance(500); expect(refreshed).toBe(false);
    finish(snapshot()); await refresh; expect(refreshed).toBe(true); f.coordinator.stop();
  });

  test("suspending discovery and cookie issuance aborts their transport before late completion", async () => {
    let complete!: (value: { capabilities: { browserRealtime: boolean } }) => void;
    let discoverySignal: AbortSignal | undefined;
    const f = fixture();
    const coordinator = new BrowserSyncCoordinator({
      now: () => f.clock.now, setTimeout: f.clock.setTimeout, clearTimeout: f.clock.clearTimeout,
      capabilities: (signal) => { discoverySignal = signal; return new Promise((resolve) => { complete = resolve; }); },
      realtimeSession: async () => {}, socket: () => new Socket(), readSnapshot: async () => snapshot(), readLegacy: async () => {},
      onSnapshot: () => {}, onEvent: () => {}, onError: () => {}, onConnection: () => {},
    });
    void coordinator.start("p"); await flush(); coordinator.suspend();
    expect(discoverySignal?.aborted).toBe(true);
    complete({ capabilities: { browserRealtime: true } }); await flush(); expect(f.clock.timers.size).toBe(0); coordinator.stop();
  });

  test("hidden cancellation fences late reads, cookie completions and socket restarts", async () => {
    let finish!: (value: SyncSnapshot) => void; let signal!: AbortSignal;
    const f = fixture({ read: (_, s) => { signal = s; return new Promise((resolve) => { finish = resolve; }); } });
    void f.coordinator.start("p"); await flush(); const oldSocket = f.sockets[0];
    f.coordinator.suspend(); expect(signal.aborted).toBe(true); expect(oldSocket.closed).toBe(true);
    finish(snapshot()); oldSocket.onopen?.(); await f.clock.advance(60000);
    expect(f.applied).toEqual([]); expect(f.sockets).toHaveLength(1); expect(f.clock.timers.size).toBe(0);
    f.coordinator.resume(); await flush(); expect(f.starts).toHaveLength(2); f.coordinator.stop();
  });

  test("selection and logout reject obsolete responses even if transport ignores abort", async () => {
    const pending: ((value: SyncSnapshot) => void)[] = [];
    const f = fixture({ read: () => new Promise((resolve) => { pending.push(resolve); }) });
    void f.coordinator.start("p"); await flush();
    f.coordinator.select("q"); await f.clock.advance(500); pending[0](snapshot()); await flush();
    expect(f.applied).toEqual([]); expect(pending).toHaveLength(2);
    f.coordinator.stop(); pending[1](snapshot(0, "e", "q")); await flush(); expect(f.applied).toEqual([]);
  });

  test("gap and heartbeat high water force a snapshot; wrong epoch closes the socket", async () => {
    let high = 0;
    const f = fixture({ read: async () => snapshot(high) }); await f.coordinator.start("p"); await flush();
    const socket = f.sockets[0]; socket.frame(hello()); await f.clock.advance(500);
    high = 3; socket.frame({ type: "ping", epoch: "e", seq: 3 }); await f.clock.advance(500);
    expect(f.applied.at(-1)?.cursor.seq).toBe(3);
    socket.frame({ type: "ping", epoch: "wrong", seq: 4 }); expect(socket.closed).toBe(true);
    await f.clock.advance(500); expect(f.sockets.length).toBeGreaterThan(1); f.coordinator.stop();
  });
  test("malformed sequenced change frames cannot reach event reducers", async () => {
    const f = fixture(); await f.coordinator.start("p"); await flush();
    const socket = f.sockets[0]; socket.frame(hello());
    socket.frame({ type: "message", epoch: "e", seq: 1 });
    expect(socket.closed).toBe(true); f.coordinator.stop();
  });

  test("invalid snapshot cursor and mismatched project never replace visible state", async () => {
    let next = snapshot(3);
    const f = fixture({ read: async () => next }); await f.coordinator.start("p"); await flush();
    next = snapshot(2); f.coordinator.invalidate(); await f.clock.advance(500);
    expect(f.applied.map((s) => s.cursor.seq)).toEqual([3]); expect(f.errors).toHaveLength(1);
    next = snapshot(4, "e", "other"); f.coordinator.invalidate(); await f.clock.advance(500);
    expect(f.applied).toHaveLength(1); f.coordinator.stop();
  });

  test("legacy capability is explicit; established v2 transport errors never downgrade", async () => {
    const old = fixture({ legacy: true }); await old.coordinator.start("p"); await flush();
    expect(old.legacy).toEqual(["p"]); expect(old.starts).toEqual([]); old.coordinator.stop();
    let fail = false;
    const modern = fixture({ read: async () => { if (fail) throw new Error("network"); return snapshot(); } });
    await modern.coordinator.start("p"); await flush(); fail = true;
    modern.coordinator.invalidate(); await modern.clock.advance(60000);
    expect(modern.legacy).toEqual([]); expect(modern.starts.length).toBeGreaterThan(3);
    const gaps = modern.starts.slice(1).map((t, i) => t - modern.starts[i]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(30000); modern.coordinator.stop();
  });
  test("an older browser contract can use v2 REST revisions with a v1 socket", async () => {
    const protocols: number[] = [], applied: SyncSnapshot[] = [], legacy: string[] = [];
    const c = new BrowserSyncCoordinator({
      capabilities: async () => ({ capabilities: { browserRealtime: false, operations: true, realtime: true } }),
      realtimeSession: async () => { throw new Error("a v1 socket needs no browser cookie"); },
      socket: (protocol) => { protocols.push(protocol); return new Socket(); },
      readSnapshot: async () => snapshot(), readLegacy: async (id) => { legacy.push(id); },
      onSnapshot: (value) => { applied.push(value); }, onEvent: () => {}, onError: () => {}, onConnection: () => {},
    });
    await c.start("p"); expect(protocols).toEqual([1]); expect(applied).toHaveLength(1); expect(legacy).toEqual([]); c.stop();
  });
});
