import { expect, test } from "bun:test";
import type { Bootstrap, Message, ProjectState } from "../shared/types";
import { applyLocal, getState, initStore, loadActivity, loadOlderMessages, login, logout, onLogout, onSessionInvalidated, reconnectNow, refresh, sendMessage, subscribe } from "../web/src/lib/store";
import type { SyncSocket } from "../web/src/lib/sync";
import { SubmissionManager } from "../web/src/lib/submissions";
import { api, getCredentialGeneration } from "../web/src/lib/api";

test("store uses v2 snapshots and opaque history cursors, then suspends and fences logout", async () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  const listeners = new Map<string, (() => void)[]>();
  const events = { addEventListener: (name: string, fn: () => void) => listeners.set(name, [...(listeners.get(name) ?? []), fn]) };
  const document = { ...events, visibilityState: "visible" };
  const values = new Map<string, string>();
  install("window", events); install("document", document);
  install("location", { hash: "#/p/p/thread", protocol: "http:", host: "fixture.invalid" });
  install("history", { replaceState: () => {} });
  const storage: Storage = {
    get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null, clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); },
  };
  install("localStorage", storage);
  const sockets: (SyncSocket & { closed: boolean })[] = [];
  install("WebSocket", class {
    static OPEN = 1;
    readyState = 0;
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null; onclose: (() => void) | null = null;
    constructor(readonly url: string) { sockets.push(this); expect(url).toBe("ws://fixture.invalid/ws?v=2"); }
    close() { this.closed = true; }
  });
  const msg = (id: string): Message => ({ id, at: "2026-01-01", projectId: "p", body: id, attachments: [], mine: false,
    memberId: null, who: "", kind: "진행", title: "", targetMemberId: null, targetName: null, decisionId: null, fileId: null, delivery: null, deliveryNote: null });
  const project = { project: { id: "p" }, messages: [], members: [
    { id: "m1", projectId: "p", status: "idle", now: "" },
    { id: "m2", projectId: "p", status: "idle", now: "" },
  ], decisions: [], todos: [], work: [], files: [] } as unknown as ProjectState;
  const revisions = { settings: 7, members: { m1: { configRevision: 1, sessionGeneration: 1 }, m2: { configRevision: 1, sessionGeneration: 1 } }, todos: {} };
  const bootstrap = { projects: [{ id: "p" }], runtime: {} } as Bootstrap;
  const calls: string[] = [];
  let replaced = false;
  let seq = 0;
  let denySync = false;
  const originalFetch = globalThis.fetch;
  const writes: ((response: Response) => void)[] = [];
  let activityResponse!: (response: Response) => void;
  install("fetch", async (input: string, init?: RequestInit) => {
    const path = String(input); calls.push(path);
    if (path === "/api/capabilities") return Response.json({ contractVersion: 2, capabilities: { browserRealtime: true } });
    if (path.includes("-session")) return new Response(null, { status: 204 });
    if (path === "/api/sync?projectId=p") return denySync ? Response.json({ error: "rotated code" }, { status: 401 }) : Response.json({ protocol: 2, cursor: { epoch: "e", seq }, requestedProjectId: "p", projectStatus: "ok", bootstrap, state: project, revisions });
    if (path === "/api/messages/reauth") return Response.json({ ...msg("reauth"), mine: true, delivery: "delivered" });
    if (path === "/api/projects/p/messages" && init?.method === "POST") return new Promise<Response>((resolve) => { writes.push(resolve); });
    if (path === "/api/members/member/activity?limit=200") return new Promise<Response>((resolve) => { activityResponse = resolve; });
    if (path.startsWith("/api/projects/p/messages/page?")) {
      const cursor = new URL(path, "http://fixture.invalid").searchParams.get("cursor");
      if (replaced) return Response.json({ projectId: "p", scope: { kind: "project" }, items: [msg("replacement")], nextCursor: null, hasOlder: false });
      return Response.json({ projectId: "p", scope: { kind: "project" }, items: [msg(cursor ? "older" : "recent")], nextCursor: cursor ? null : "opaque+/=", hasOlder: !cursor });
    }
    if (path === "/api/runtime") return Response.json({});
    if (path === "/api/bootstrap") return Response.json(bootstrap);
    if (path === "/api/projects/p/state") return Response.json(project);
    throw new Error(`Unexpected fixture request ${path}`);
  });
  try {
    initStore(); expect(await login("fixture")).toBe(true);
    expect(calls.some((p) => p.startsWith("/api/sync?"))).toBe(true);
    expect(getState().project?.messages.map((m) => m.id)).toEqual(["recent"]);
    expect(getState().syncRevisions?.settings).toBe(7);
    const initial = getState();
    await refresh();
    const equal = getState();
    expect(equal.acceptedSnapshotVersion).toBeNumber();
    expect(equal.acceptedSnapshotVersion).toBe(initial.acceptedSnapshotVersion + 1);
    expect(equal.bootstrap).toBe(initial.bootstrap);
    expect(equal.project).toBe(initial.project);
    expect(equal.syncRevisions).toBe(initial.syncRevisions);
    project.members[0] = { ...project.members[0], status: "working", now: "reading source" };
    seq = 1;
    await refresh();
    const changed = getState();
    expect(changed.project?.members[0].status).toBe("working");
    expect(changed.project?.members[0].now).toBe("reading source");
    expect(changed.syncRevisions?.members.m1.configRevision).toBe(1);
    expect(changed.project?.members[0]).not.toBe(initial.project?.members[0]);
    expect(changed.project?.members[1]).toBe(initial.project?.members[1]);
    for (const key of ["messages", "files", "todos", "decisions", "work"] as const) {
      expect(changed.project?.[key]).toBe(initial.project?.[key]);
    }
    expect(changed.bootstrap).toBe(initial.bootstrap);
    expect(changed.syncRevisions).toBe(initial.syncRevisions);
    project.members = [project.members[1], project.members[0]];
    seq = 2;
    await refresh();
    expect(getState().project?.members[0]).toBe(changed.project?.members[1]);
    expect(getState().project?.members[1]).toBe(changed.project?.members[0]);
    expect(getState().project?.messages).toBe(changed.project?.messages);
    expect(getState().acceptedSnapshotVersion).toBe(changed.acceptedSnapshotVersion + 1);
    await loadOlderMessages();
    expect(calls.some((p) => p.includes("cursor=opaque%2B%2F%3D") && p.includes("limit=50"))).toBe(true);
    expect(getState().project?.messages.map((m) => m.id)).toEqual(["older", "recent"]);
    const socket = sockets.at(-1)!;
    socket.onmessage?.({ data: JSON.stringify({ type: "hello", protocol: 2, epoch: "e", seq: 0, heartbeatMs: 15000, staleAfterMs: 45000 }) });
    let publications = 0; const unsubscribe = subscribe(() => { publications++; });
    for (let i = 1; i <= 20; i++) { seq = i; socket.onmessage?.({ data: JSON.stringify({ type: "message", epoch: "e", seq: i, message: msg(`z${String(i).padStart(2, "0")}`) }) }); }
    expect(publications).toBe(0);
    await Bun.sleep(275); expect(publications).toBe(1);
    expect(getState().project?.messages.filter((m) => m.id.startsWith("z"))).toHaveLength(20);
    applyLocal({ type: "message", message: { ...msg("instant"), mine: true, delivery: "queued" } });
    expect(publications).toBe(2); unsubscribe();
    const firstWrite = sendMessage({ id: "new", text: "hello" });
    const delivered = { ...msg("new"), mine: true, delivery: "delivered" as const };
    applyLocal({ type: "message", message: delivered });
    writes[0](Response.json({ ...delivered, delivery: "sent" }));
    expect((await firstWrite)?.delivery).toBe("delivered");
    const refused = sendMessage({ id: "refused", text: "hold in composer" }, { onRejected: () => true });
    writes[1](Response.json({ error: "not connected" }, { status: 409 })); await refused;
    await refresh();
    expect(getState().project?.messages.some((m) => m.id === "refused")).toBe(false);
    replaced = true; await refresh();
    expect(getState().historyError).toContain("변경");
    expect(getState().project?.messages.some((m) => m.id === "recent")).toBe(true);
    reconnectNow(); await refresh();
    expect(getState().historyError).toBeNull();
    expect(getState().project?.messages.some((m) => m.id === "replacement")).toBe(true);
    expect(getState().project?.messages.some((m) => m.id === "instant")).toBe(true);
    const manager = new SubmissionManager({ storage, host: "http://fixture.invalid", session: getCredentialGeneration, newId: () => "reauth",
      send: (attempt) => sendMessage(attempt.payload), lookup: (id) => api.message(id), accepted: (message) => applyLocal({ type: "message", message }) });
    let sessionInvalidations = 0;
    onSessionInvalidated(() => { sessionInvalidations++; manager.invalidate(); });
    manager.patchDraft("p", (draft) => ({ ...draft, text: "immutable pending request" }));
    const pendingAttempt = manager.submit("p", manager.snapshot("p").draft, { text: "immutable pending request", targetMemberId: null, attachmentIds: [] }, {});
    manager.patchDraft("p", (draft) => ({ ...draft, text: "later edits" }));
    const attemptKey = [...values.keys()].find((key) => key.startsWith("iamceo.draft.host."))!;
    values.set("iamceo.draft.legacy", "unsent draft"); values.set("iamceo.memo.p", "private memo");
    let destructiveLogouts = 0;
    onLogout(() => { destructiveLogouts++; manager.clear(); values.delete("iamceo.draft.legacy"); values.delete("iamceo.memo.p"); });
    denySync = true; await refresh();
    expect(getState().auth).toBe("need_code");
    expect(sessionInvalidations).toBe(1);
    expect(destructiveLogouts).toBe(0);
    expect(values.has(attemptKey)).toBe(true);
    expect([...values.values()].some((value) => value.includes('"id":"reauth"'))).toBe(true);
    expect(values.get("iamceo.draft.legacy")).toBe("unsent draft"); expect(values.get("iamceo.memo.p")).toBe("private memo");
    writes[2](Response.json({ ...msg("reauth"), mine: true, delivery: "delivered" }));
    expect(await pendingAttempt).toBe(false); expect(getState().project).toBeNull();
    denySync = false; expect(await login("new-fixture-code")).toBe(true);
    expect(sessionInvalidations).toBe(2);
    await manager.reconcile("p");
    expect(manager.snapshot("p").attempts).toHaveLength(0); expect(manager.snapshot("p").draft.text).toBe("later edits");
    expect(calls.filter((path) => path === "/api/messages/reauth")).toHaveLength(1);
    const lateWrite = sendMessage({ id: "late", text: "will log out" });
    const lateActivity = loadActivity("member");
    document.visibilityState = "hidden"; for (const fn of listeners.get("visibilitychange") ?? []) fn();
    expect(sockets.every((s) => s.closed)).toBe(true);
    const count = calls.length;
    for (const fn of listeners.get("online") ?? []) fn(); await Promise.resolve(); expect(calls).toHaveLength(count);
    logout(); writes[3](Response.json(msg("late")));
    expect(await lateWrite).toBeNull(); expect(getState().project).toBeNull();
    activityResponse(Response.json([{ id: 1, memberId: "member" }])); await lateActivity;
    expect(getState().activity).toEqual({});
  } finally {
    logout();
    globalThis.fetch = originalFetch;
    for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
}, 15000);
