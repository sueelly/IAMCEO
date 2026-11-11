import { describe, expect, test } from "bun:test";
import type { Attachment, Message } from "../shared/types";
import { SubmissionManager, type MessageAttempt } from "../web/src/lib/submissions";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  blocked = false;
  blockedDraftWrites = false;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.blocked || (this.blockedDraftWrites && !key.includes(".attempt:"))) throw new Error("quota"); this.values.set(key, value); }
  removeItem(key: string) { if (this.blocked) throw new Error("quota"); this.values.delete(key); }
}
const attachment: Attachment = { id: "a1", name: "first.txt", mime: "text/plain", size: 4, url: "/files/a1", path: "/a1", isImage: false };
const message = (id = "m1", patch: Partial<Message> = {}): Message => ({ id, projectId: "p1", at: "2026-11-09T00:00:00Z", mine: true, memberId: null, who: "나", kind: "나", title: "", body: "original", targetMemberId: "worker1", targetName: "직원1", decisionId: null, fileId: null, attachments: [attachment], delivery: "queued", deliveryNote: null, ...patch });
const missing = () => { throw Object.assign(new Error("없음"), { status: 404 }); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const directWorker = { memberId: "worker1", targetMemberId: "worker1", targetName: "직원1" };
function fixture(opts: { idPrefix?: string; direct?: typeof directWorker; storage?: MemoryStorage; host?: string; send?: (attempt: MessageAttempt) => Promise<Message | null>; lookup?: (id: string) => Promise<Message>; accepted?: (message: Message) => void } = {}) {
  const storage = opts.storage ?? new MemoryStorage();
  let session = "login1";
  let nextId = 0;
  const manager = new SubmissionManager({ storage, direct: opts.direct, host: opts.host ?? "http://host:7881", session: () => session, newId: () => `${opts.idPrefix ?? "m"}${++nextId}`, send: opts.send ?? (async () => null), lookup: opts.lookup ?? (async () => missing()), accepted: opts.accepted ?? (() => {}) });
  return { manager, storage, login: (value: string) => { session = value; } };
}
function draft(manager: SubmissionManager, text = "original", targetId: string | null = "worker1") {
  manager.patchDraft("p1", (d) => ({ ...d, text, targetId, uploads: [{ key: "u1", name: attachment.name, attachment, failed: false }] }));
  return manager.snapshot("p1").draft;
}
const body = { text: "original", targetMemberId: "worker1", attachmentIds: ["a1"] };

describe("durable browser message attempts", () => {
  test("persists immutable attempt before input clear/network; reload queries accepted same ID without resend", async () => {
    const response = deferred<Message | null>();
    const storage = new MemoryStorage();
    const f = fixture({ storage, send: async (attempt) => {
      const restored = fixture({ storage }).manager.snapshot("p1");
      expect(restored.attempts[0]?.payload).toEqual({ id: "m1", ...body });
      expect(restored.draft.text).toBe("");
      return response.promise;
    } });
    const submit = f.manager.submit("p1", draft(f.manager), body, { targetName: "직원1", attachments: [attachment] });
    expect(f.manager.snapshot("p1").draft.text).toBe("");
    let resend = 0;
    const accepted: Message[] = [];
    const reload = fixture({ storage, send: async () => { resend++; return null; }, lookup: async (id) => message(id), accepted: (m) => accepted.push(m) });
    await reload.manager.reconcile("p1");
    expect(accepted.map((m) => m.id)).toEqual(["m1"]);
    expect(reload.manager.snapshot("p1").attempts).toEqual([]);
    expect(resend).toBe(0);
    response.resolve(message());
    await submit;
  });

  test("retry keeps original ID/body/recipient/attachments while a later draft remains untouched", async () => {
    const sent: MessageAttempt[] = [];
    const f = fixture({ send: async (attempt) => { sent.push(attempt); return null; } });
    const firstDraft = draft(f.manager);
    const submitted = { ...body, attachmentIds: [...body.attachmentIds] };
    await f.manager.submit("p1", firstDraft, submitted, { targetName: "직원1", attachments: [attachment] });
    f.manager.patchDraft("p1", (d) => ({ ...d, text: "later", targetId: "worker2", uploads: [] }));
    submitted.attachmentIds.push("temporary");
    await f.manager.retry("p1", "m1");
    expect(sent.map((a) => a.payload)).toEqual([{ id: "m1", ...body }, { id: "m1", ...body }]);
    expect(f.manager.snapshot("p1").draft).toMatchObject({ text: "later", targetId: "worker2", uploads: [] });
    expect(f.manager.snapshot("p1").attempts[0]?.status).toBe("retryable");
  });

  test("lost acknowledgement never prepends sent text or replaces newer target/uploads", async () => {
    const response = deferred<Message | null>();
    const f = fixture({ send: () => response.promise });
    const submit = f.manager.submit("p1", draft(f.manager), body, { attachments: [attachment] });
    f.manager.patchDraft("p1", (d) => ({ ...d, text: "later", targetId: "worker2", uploads: [{ key: "u2", name: "later.txt", attachment: null, failed: false }] }));
    response.resolve(null);
    await submit;
    expect(f.manager.snapshot("p1").draft).toMatchObject({ text: "later", targetId: "worker2", uploads: [{ key: "u2" }] });
    expect(f.manager.snapshot("p1").attempts[0]).toMatchObject({ id: "m1", payload: { text: "original", targetMemberId: "worker1" }, status: "retryable" });
  });

  test("accepted lookup after reload preserves the later draft even when it repeats the submitted text", async () => {
    const f = fixture();
    await f.manager.submit("p1", draft(f.manager), body, {});
    f.manager.patchDraft("p1", (d) => ({ ...d, text: "original", targetId: "worker2", uploads: [{ key: "new", name: "new.txt", attachment: null, failed: true }] }));
    const restored = fixture({ storage: f.storage, lookup: async (id) => message(id) });
    await restored.manager.reconcile("p1");
    expect(restored.manager.snapshot("p1").attempts).toEqual([]);
    expect(restored.manager.snapshot("p1").draft).toMatchObject({ text: "original", targetId: "worker2", uploads: [{ key: "new", failed: true }] });
  });

  test("an accepted but failed delivery remains retryable with the original request", async () => {
    const sent: MessageAttempt[] = [];
    const f = fixture({ send: async (attempt) => { sent.push(attempt); return message(attempt.id, { delivery: sent.length === 1 ? "failed" : "queued", deliveryNote: "연결 필요" }); }, lookup: async (id) => message(id, { delivery: "failed" }) });
    expect(await f.manager.submit("p1", draft(f.manager), body, {})).toBe(false);
    expect(f.manager.snapshot("p1").attempts[0]?.status).toBe("retryable");
    expect(await f.manager.retry("p1", "m1")).toBe(true);
    expect(sent.map((a) => a.payload)).toEqual([{ id: "m1", ...body }, { id: "m1", ...body }]);
    expect(f.manager.snapshot("p1").attempts).toEqual([]);
  });

  test("legacy retry metadata migrates to an immutable pending request with its same ID", async () => {
    const storage = new MemoryStorage();
    storage.setItem("iamceo.draft.p1", JSON.stringify({ text: "original", targetId: "worker1", uploads: [{ key: "u1", name: attachment.name, attachment, failed: false }], retry: { id: "legacy", signature: JSON.stringify(["original", "worker1", ["a1"]]), text: "original" } }));
    const f = fixture({ storage });
    expect(f.manager.snapshot("p1").attempts[0]?.payload).toEqual({ id: "legacy", ...body });
    expect(f.manager.snapshot("p1").draft.text).toBe("");
    expect(storage.getItem("iamceo.draft.p1")).toBeNull();
    const reloaded = fixture({ storage, lookup: async (id) => message(id) });
    await reloaded.manager.reconcile("p1");
    expect(reloaded.manager.snapshot("p1").attempts).toEqual([]);
  });

  test("storage failure retains input and blocks network rather than claiming recovery is durable", async () => {
    let sends = 0;
    const f = fixture({ send: async () => { sends++; return message(); } });
    const original = draft(f.manager);
    f.storage.blocked = true;
    expect(await f.manager.submit("p1", original, body, {})).toBe(false);
    expect(sends).toBe(0);
    expect(f.manager.snapshot("p1").draft).toMatchObject({ text: "original", targetId: "worker1", error: expect.stringContaining("저장") });
    expect(f.manager.snapshot("p1").attempts).toEqual([]);
  });

  test("lookup failure permits explicit retry but never automatically sends; concurrent checks are single flight", async () => {
    const check = deferred<Message>();
    const storage = new MemoryStorage();
    const original = fixture({ storage });
    await original.manager.submit("p1", draft(original.manager), body, {});
    let checks = 0, sends = 0;
    const f = fixture({ storage, lookup: async () => { checks++; return check.promise; }, send: async () => { sends++; return message(); } });
    const a = f.manager.reconcile("p1");
    const b = f.manager.reconcile("p1");
    expect(f.manager.snapshot("p1").attempts[0]?.status).toBe("checking");
    check.reject(new Error("offline"));
    await Promise.all([a, b]);
    expect(checks).toBe(1);
    expect(sends).toBe(0);
    expect(f.manager.snapshot("p1").attempts[0]?.status).toBe("retryable");
  });

  test("late results after logout/login cannot restore attempts or change the new draft", async () => {
    const response = deferred<Message | null>();
    let applied = 0;
    const f = fixture({ send: () => response.promise, accepted: () => { applied++; } });
    const submit = f.manager.submit("p1", draft(f.manager), body, {});
    f.manager.clear();
    f.login("login2");
    f.manager.patchDraft("p1", (d) => ({ ...d, text: "new login" }));
    response.resolve(message());
    await submit;
    expect(applied).toBe(0);
    expect(f.manager.snapshot("p1").draft.text).toBe("new login");
    expect(f.manager.snapshot("p1").attempts).toEqual([]);
    const reload = fixture({ storage: f.storage });
    expect(reload.manager.snapshot("p1").attempts).toEqual([]);
  });

  test("host scopes do not expose drafts/attempts to another daemon", async () => {
    const f = fixture();
    await f.manager.submit("p1", draft(f.manager), body, {});
    const other = fixture({ storage: f.storage, host: "http://host:7882" });
    expect(other.manager.snapshot("p1").attempts).toEqual([]);
    expect(other.manager.snapshot("p1").draft.text).toBe("");
  });
});

describe("recoverable attachments", () => {
  test("reload preserves interrupted and failed upload entries with reselect guidance", () => {
    const f = fixture();
    f.manager.patchDraft("p1", (d) => ({ ...d, uploads: [
      { key: "u1", name: "interrupted.txt", attachment: null, failed: false },
      { key: "u2", name: "failed.txt", attachment: null, failed: true },
      { key: "u3", name: attachment.name, attachment, failed: false },
    ] }));
    const restored = fixture({ storage: f.storage }).manager.snapshot("p1").draft;
    expect(restored.uploads.map((u) => [u.name, u.failed])).toEqual([["interrupted.txt", true], ["failed.txt", true], ["first.txt", false]]);
    expect(restored.error).toContain("다시 선택");
  });

  test("late upload completion cannot revive deleted entries, overwrite a changed recipient, or cross logout", () => {
    const f = fixture();
    const ticket = f.manager.beginUpload("p1", { key: "u1", name: "file" });
    f.manager.patchDraft("p1", (d) => ({ ...d, text: "later", targetId: "worker2", uploads: [] }));
    expect(f.manager.finishUpload(ticket, attachment)).toBe(false);
    expect(f.manager.snapshot("p1").draft).toMatchObject({ text: "later", targetId: "worker2", uploads: [], error: null });
    const second = f.manager.beginUpload("p1", { key: "u2", name: "file" });
    f.manager.clear();
    f.login("login2");
    f.manager.patchDraft("p1", (d) => ({ ...d, text: "new login" }));
    expect(f.manager.finishUpload(second, attachment)).toBe(false);
    expect(f.manager.snapshot("p1").draft.text).toBe("new login");
    expect(f.manager.snapshot("p1").draft.uploads).toEqual([]);
  });

  test("upload failure stays visible without clobbering another project's input", () => {
    const f = fixture();
    const ticket = f.manager.beginUpload("p1", { key: "u1", name: "file" });
    f.manager.patchDraft("p2", (d) => ({ ...d, text: "other project" }));
    expect(f.manager.finishUpload(ticket, null, "서버에 연결할 수 없습니다")).toBe(true);
    expect(f.manager.snapshot("p1").draft.uploads).toEqual([{ key: "u1", name: "file", attachment: null, failed: true }]);
    expect(f.manager.snapshot("p2").draft.text).toBe("other project");
  });
});


describe("direct member submission path and shared storage", () => {
  test("member-scoped lost acknowledgement survives reload without sending another ID or touching the bottom composer", async () => {
    const storage = new MemoryStorage();
    const main = fixture({ storage });
    main.manager.patchDraft("p1", (d) => ({ ...d, text: "bottom composer", targetId: "worker2" }));
    const response = deferred<Message | null>();
    let sends = 0;
    const direct = fixture({ storage, direct: directWorker, send: async (attempt) => {
      sends++;
      expect(attempt.projectId).toBe("p1");
      expect(attempt.payload.targetMemberId).toBe("worker1");
      const reloaded = fixture({ storage, direct: directWorker }).manager.snapshot("p1");
      expect(reloaded.attempts[0]?.id).toBe("m1");
      return response.promise;
    } });
    direct.manager.patchDraft("p1", (d) => ({ ...d, text: "direct original" }));
    const submit = direct.manager.submit("p1", direct.manager.snapshot("p1").draft, { text: "direct original", targetMemberId: "worker1", attachmentIds: [] }, { targetName: "직원1" });
    direct.manager.patchDraft("p1", (d) => ({ ...d, text: "later direct draft" }));
    const restored = fixture({ storage, direct: directWorker, lookup: async (id) => message(id, { body: "direct original", attachments: [] }), send: async () => { sends++; return null; } });
    await restored.manager.reconcile("p1");
    expect(restored.manager.snapshot("p1").attempts).toEqual([]);
    expect(restored.manager.snapshot("p1").draft.text).toBe("later direct draft");
    expect(fixture({ storage }).manager.snapshot("p1").draft).toMatchObject({ text: "bottom composer", targetId: "worker2" });
    expect(sends).toBe(1);
    response.resolve(null);
    await submit;
  });

  test("member-scoped late null completion after logout cannot recreate a direct draft or pending record", async () => {
    const response = deferred<Message | null>();
    const direct = fixture({ direct: directWorker, send: () => response.promise });
    direct.manager.patchDraft("p1", (d) => ({ ...d, text: "old login" }));
    const submit = direct.manager.submit("p1", direct.manager.snapshot("p1").draft, { text: "old login", targetMemberId: "worker1", attachmentIds: [] }, {});
    direct.manager.clear();
    direct.login("login2");
    direct.manager.patchDraft("p1", (d) => ({ ...d, text: "new login" }));
    response.resolve(null);
    await submit;
    const restored = fixture({ storage: direct.storage, direct: directWorker }).manager.snapshot("p1");
    expect(restored.draft.text).toBe("new login");
    expect(restored.attempts).toEqual([]);
    expect(direct.storage.getItem("iamceo.draft.direct.worker1")).toBeNull();
  });

  test("legacy direct retry migrates its immutable ID/body/recipient separately from later edits", async () => {
    const storage = new MemoryStorage();
    storage.setItem("iamceo.draft.direct.worker1", JSON.stringify({ text: "later direct draft", retry: { id: "legacy-direct", text: "original direct instruction" } }));
    const direct = fixture({ storage, direct: directWorker });
    const restored = direct.manager.snapshot("p1");
    expect(restored.draft.text).toBe("later direct draft");
    expect(restored.attempts[0]).toMatchObject({ id: "legacy-direct", projectId: "p1", payload: { id: "legacy-direct", text: "original direct instruction", targetMemberId: "worker1", attachmentIds: [] } });
    expect(storage.getItem("iamceo.draft.direct.worker1")).toBeNull();
    expect(fixture({ storage }).manager.snapshot("p1").draft.text).toBe("");
  });

  test("a stale second tab cannot erase an uncertain attempt or resurrect a settled one by editing", async () => {
    const storage = new MemoryStorage();
    const response = deferred<Message | null>();
    const a = fixture({ storage, send: () => response.promise });
    const b = fixture({ storage });
    b.manager.snapshot("p1"); // Cached before the other tab creates an attempt.
    const send = a.manager.submit("p1", draft(a.manager), body, {});
    b.manager.patchDraft("p1", (d) => ({ ...d, text: "from second tab" }));
    const restored = fixture({ storage, lookup: async (id) => message(id) });
    expect(restored.manager.snapshot("p1").attempts.map((attempt) => attempt.id)).toEqual(["m1"]);
    await restored.manager.reconcile("p1");
    b.manager.patchDraft("p1", (d) => ({ ...d, text: "second tab after settlement" }));
    const after = fixture({ storage }).manager.snapshot("p1");
    expect(after.attempts).toEqual([]);
    expect(after.draft.text).toBe("second tab after settlement");
    response.resolve(message());
    await send;
    expect(fixture({ storage }).manager.snapshot("p1").draft.text).toBe("second tab after settlement");
  });

  test("a crash with a persisted attempt and uncleared disk draft does not revive the instruction as new input", async () => {
    const response = deferred<Message | null>();
    const f = fixture({ send: () => response.promise });
    const original = draft(f.manager);
    f.storage.blockedDraftWrites = true;
    const send = f.manager.submit("p1", original, body, {});
    const restored = fixture({ storage: f.storage });
    expect(restored.manager.snapshot("p1").draft.text).toBe("");
    expect(restored.manager.snapshot("p1").attempts[0]?.payload.id).toBe("m1");
    response.resolve(message());
    await send;
    f.storage.blockedDraftWrites = false;
    const after = fixture({ storage: f.storage, lookup: async (id) => message(id) });
    await after.manager.reconcile("p1");
    expect(after.manager.snapshot("p1").draft.text).toBe("");
    expect(after.manager.snapshot("p1").attempts).toEqual([]);
  });
});

describe("non-destructive authentication invalidation", () => {
  test("401/rotation retains immutable attempts and newer drafts, fences late responses, and reconciles after login", async () => {
    const response = deferred<Message | null>();
    let accepted = 0;
    const f = fixture({ send: () => response.promise, lookup: async (id) => message(id), accepted: () => { accepted++; } });
    const submit = f.manager.submit("p1", draft(f.manager), body, {});
    f.manager.patchDraft("p1", (d) => ({ ...d, text: "after send", targetId: "worker2" }));
    const persisted = new Map(f.storage.values);
    f.manager.invalidate();
    f.login("rotated code");
    response.resolve(message());
    await submit;
    expect(accepted).toBe(0);
    expect(f.storage.values).toEqual(persisted);
    expect(f.manager.snapshot("p1").draft).toMatchObject({ text: "after send", targetId: "worker2" });
    expect(f.manager.snapshot("p1").attempts[0]?.id).toBe("m1");
    await f.manager.reconcile("p1");
    expect(accepted).toBe(1);
    expect(f.manager.snapshot("p1").attempts).toEqual([]);
    expect(fixture({ storage: f.storage }).manager.snapshot("p1").draft.text).toBe("after send");
  });

  test("401 invalidation leaves an interrupted upload visible and fences its old credential result", () => {
    const f = fixture();
    const upload = f.manager.beginUpload("p1", { key: "u1", name: "interrupted.txt" });
    f.manager.invalidate();
    f.login("rotated code");
    expect(f.manager.finishUpload(upload, attachment)).toBe(false);
    expect(f.manager.snapshot("p1").draft.uploads).toEqual([{ key: "u1", name: "interrupted.txt", attachment: null, failed: true }]);
    expect(f.manager.snapshot("p1").draft.error).toContain("다시 선택");
  });
});


test("a second tab displaying the captured source draft cannot submit it with a new ID", async () => {
  const storage = new MemoryStorage();
  const response = deferred<Message | null>();
  const a = fixture({ storage, send: () => response.promise });
  const original = draft(a.manager);
  let sends = 0;
  const b = fixture({ storage, idPrefix: "tab-b-", send: async () => { sends++; return null; } });
  const stale = b.manager.snapshot("p1").draft;
  const submitted = a.manager.submit("p1", original, body, {});
  expect(await b.manager.submit("p1", stale, body, {})).toBe(false);
  expect(sends).toBe(0);
  expect(b.manager.snapshot("p1").draft.text).toBe("");
  response.resolve(message());
  await submitted;
});

test("version-one embedded attempts remain recoverable until schema cleanup is durable", async () => {
  const storage = new MemoryStorage();
  const key = `iamceo.draft.host.${encodeURIComponent("http://host:7881")}.p1`;
  storage.setItem(key, JSON.stringify({ version: 1, draft: { text: "", targetId: null, uploads: [], error: null }, attempts: [{ id: "m1", projectId: "p1", payload: { id: "m1", ...body }, targetName: "직원1", attachments: [attachment], status: "checking", error: null }] }));
  storage.blockedDraftWrites = true;
  let sends = 0;
  const f = fixture({ storage, lookup: async (id) => message(id), send: async () => { sends++; return null; } });
  await f.manager.reconcile("p1");
  expect(f.manager.snapshot("p1").attempts[0]?.id).toBe("m1");
  expect(sends).toBe(0);
  storage.blockedDraftWrites = false;
  await f.manager.reconcile("p1");
  expect(fixture({ storage }).manager.snapshot("p1").attempts).toEqual([]);
});
