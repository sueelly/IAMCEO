import type { Attachment, Message, SendMessageReq } from "@shared/types";

export interface Upload { key: string; name: string; attachment: Attachment | null; failed: boolean }
/** taskId: 대화에서 고른 작업(없으면 전체). 보낼 때 그 순간의 값이 글에 고정된다. */
export interface Draft { text: string; targetId: string | null; uploads: Upload[]; error: string | null; taskId?: string | null }
/** 보낸 순간의 요청. taskId 는 옛 기기에 남은 시도에는 없다(= 전체). */
export type SendPayload = Required<Omit<SendMessageReq, "taskId" | "newTaskTitle">> & { taskId?: string | null; newTaskTitle?: string | null };
export interface MessageAttempt {
  readonly id: string;
  readonly projectId: string;
  readonly payload: Readonly<SendPayload>;
  readonly targetName: string | null;
  readonly attachments: Attachment[];
  readonly sourceRevision: string | null;
  /** sending: 이 화면에서 처음 보내는 중(결과를 알기 전까지 따로 보이지 않는다). 기기에는 늘 checking 으로 남는다. */
  readonly status: "sending" | "checking" | "retryable";
  readonly error: string | null;
}
interface ProjectDraft { readonly draft: Draft; readonly attempts: readonly MessageAttempt[]; readonly revision: string }
interface UploadTicket { readonly projectId: string; readonly key: string; readonly targetId: string | null; readonly generation: number; readonly session: string | number | null }
interface Options {
  storage: Storage;
  host: string;
  /** Storage scope only. Requests always retain their actual project ID. */
  direct?: { memberId: string; targetMemberId: string | null; targetName: string };
  session: () => string | number | null;
  newId: () => string;
  send: (attempt: MessageAttempt) => Promise<Message | null>;
  lookup: (id: string) => Promise<Message>;
  accepted: (message: Message) => void;
}
const emptyDraft = (): Draft => ({ text: "", targetId: null, uploads: [], error: null });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const revision = (): string => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}-${Math.random()}`;
const readableError = (error: unknown): string => error instanceof Error ? error.message : String(error);
const storageError = "이 기기에 전송 내용을 저장할 수 없습니다. 글은 입력칸에 남겨 두었습니다. 저장 공간을 확보한 뒤 다시 보내 주세요";
const uploadRecovery = "올리지 못한 첨부가 있습니다. 해당 파일을 빼고 다시 선택해 주세요";

/**
 * 서버가 저장하기 전에 받지 않겠다고 답한 전송(연결 게이트 409). send 가 이 오류를 던지면 서버에 그 id 의 글이 없다.
 * 처음 보낸 새 id 라면 글을 입력칸에 되돌리고 시도를 지운다. 응답 유실·네트워크 오류는 이 오류가 아니다.
 */
export class SubmissionRefused extends Error {
  readonly refused = true;
}
const isRefused = (error: unknown): error is SubmissionRefused => error instanceof SubmissionRefused || (error as { refused?: unknown })?.refused === true;

/** Immutable attempts have individual keys: a stale tab saving its draft can never
 * erase another tab's pending ID or resurrect a settled one. The source revision
 * also covers a crash between persisting an attempt and clearing the disk draft. */
export class SubmissionManager {
  private readonly prefix: string;
  private readonly scope: string;
  private readonly projects = new Map<string, ProjectDraft>();
  private readonly migrations = new Map<string, MessageAttempt[]>();
  private readonly listeners = new Set<() => void>();
  private readonly checks = new Map<string, Promise<boolean>>();
  private readonly sends = new Set<string>();
  /** 이 화면에서 submit 한 뒤 아직 결과를 모르는 첫 전송: 되돌릴 원래 입력칸과 비운 뒤의 입력칸. */
  private readonly firstSends = new Map<string, { before: Draft; cleared: Draft }>();
  private generation = 0;

  constructor(private readonly options: Options) {
    this.prefix = `iamceo.draft.host.${encodeURIComponent(options.host)}.`;
    this.scope = options.direct ? `direct:${encodeURIComponent(options.direct.memberId)}:` : "";
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  snapshot(projectId: string): ProjectDraft {
    const known = this.projects.get(projectId);
    if (known) return known;
    let state: ProjectDraft = { draft: emptyDraft(), attempts: [], revision: revision() };
    try {
      const scoped = this.options.storage.getItem(this.key(projectId));
      const legacyKey = this.options.direct ? `iamceo.draft.direct.${this.options.direct.memberId}` : `iamceo.draft.${projectId}`;
      const raw = scoped ?? this.options.storage.getItem(legacyKey);
      const saved = raw ? JSON.parse(raw) : null;
      const source = scoped ? saved?.draft : saved;
      const uploads = Array.isArray(source?.uploads) ? source.uploads.filter(validUpload).map((u: Upload) => ({ ...u, failed: !u.attachment || u.failed })) : [];
      const draft: Draft = { text: typeof source?.text === "string" ? source.text : "", targetId: typeof source?.targetId === "string" ? source.targetId : null, uploads, error: uploads.some((u: Upload) => u.failed) ? uploadRecovery : null,
        ...(typeof source?.taskId === "string" ? { taskId: source.taskId } : {}) };
      const legacy: MessageAttempt[] = scoped && Array.isArray(saved?.attempts) ? saved.attempts.filter((a: unknown) => validAttempt(a, projectId)).map((a: MessageAttempt) => freezeAttempt({ ...a, sourceRevision: null, status: "checking", error: null })) : [];
      if (!scoped && typeof source?.retry?.id === "string") {
        const attempt = this.legacyRetry(projectId, source.retry, uploads);
        if (attempt) {
          legacy.push(attempt);
          if (draft.text === source.retry.text) Object.assign(draft, emptyDraft());
        }
      }
      if (legacy.length) this.migrations.set(projectId, legacy);
      this.migrateAttempts(projectId);
      state = { draft, attempts: this.readAttempts(projectId, legacy), revision: typeof saved?.revision === "string" ? saved.revision : revision() };
      if (state.attempts.some((a) => a.sourceRevision === state.revision)) state = { ...state, draft: emptyDraft(), revision: revision() };
      if (raw && (!scoped || saved?.version !== 2 || state.draft !== draft)) {
        if (this.writeDraft(projectId, state) && !scoped) this.options.storage.removeItem(legacyKey);
      }
    } catch { /* Storage can be unavailable. submit still requires a durable attempt. */ }
    this.projects.set(projectId, state);
    return state;
  }

  patchDraft(projectId: string, update: (draft: Draft) => Draft): void {
    const state = this.syncAttempts(projectId);
    const draft = update(state.draft);
    if (draft === state.draft) return;
    const next = { ...state, draft, revision: revision() };
    this.writeDraft(projectId, next);
    this.replace(projectId, next);
  }

  async submit(projectId: string, expected: Draft, req: Omit<SendPayload, "id">, extra: { targetName?: string | null; attachments?: Attachment[] }): Promise<boolean> {
    const state = this.syncAttempts(projectId);
    if (state.draft !== expected) return false;
    const id = this.options.newId();
    const attempt = freezeAttempt({ id, projectId, payload: { id, ...copy(req) }, targetName: extra.targetName ?? null, attachments: copy(extra.attachments ?? []), sourceRevision: state.revision, status: "checking", error: null });
    try {
      if (!this.migrateAttempts(projectId)) throw new Error("migration storage unavailable");
      if (this.options.storage.getItem(this.attemptKey(projectId, id))) throw new Error("duplicate attempt ID");
      // The immutable request must exist before input clearing or any network write.
      this.options.storage.setItem(this.attemptKey(projectId, id), JSON.stringify(attempt));
    } catch {
      this.replace(projectId, { ...state, draft: { ...state.draft, error: storageError } });
      return false;
    }
    // 작업을 골라 보냈으면 그 작업과 받는 직원은 그대로 둔다. 다음 글도 같은 작업에서 이어 쓴다. 전체에서는 예전처럼 대상도 비운다.
    const kept: Draft = state.draft.taskId ? { ...emptyDraft(), targetId: state.draft.targetId, taskId: state.draft.taskId } : emptyDraft();
    const next = { draft: kept, attempts: [...state.attempts, attempt], revision: revision() };
    // If this disk write fails, sourceRevision suppresses the captured old draft on
    // reload. A different tab's newer disk revision must never be cleared here.
    this.writeDraft(projectId, next, state.revision);
    this.replace(projectId, next);
    this.firstSends.set(id, { before: state.draft, cleared: kept });
    return this.transmit(attempt);
  }

  async reconcile(projectId: string): Promise<void> {
    await Promise.all(this.syncAttempts(projectId).attempts.map((attempt) => this.check(attempt)));
  }
  async retry(projectId: string, id: string): Promise<boolean> {
    const attempt = this.syncAttempts(projectId).attempts.find((a) => a.id === id);
    if (!attempt || this.sends.has(id)) return false;
    const generation = this.generation, session = this.options.session();
    const accepted = await this.check(attempt);
    if (!this.current(generation, session)) return false;
    if (accepted) return true;
    const remaining = this.syncAttempts(projectId).attempts.find((a) => a.id === id);
    return remaining ? this.transmit(remaining) : true;
  }
  observe(projectId: string, messages: readonly Message[]): void {
    for (const attempt of this.syncAttempts(projectId).attempts) {
      // queued may be an optimistic row; an ID lookup is still required for it.
      const found = messages.find((m) => m.id === attempt.id && m.projectId === projectId && m.mine && m.delivery !== "queued" && m.delivery !== "failed" && m.delivery !== null);
      if (found) this.settle(attempt, found);
    }
  }

  beginUpload(projectId: string, file: { key: string; name: string }): UploadTicket {
    const ticket = { projectId, key: file.key, targetId: this.snapshot(projectId).draft.targetId, generation: this.generation, session: this.options.session() };
    this.patchDraft(projectId, (d) => ({ ...d, uploads: [...d.uploads, { ...file, attachment: null, failed: false }], error: null }));
    return ticket;
  }
  /** 연결 때문에 서버가 첨부를 받지 않았다. 칩을 실패로 남기지 않고 어디에 막혔는지만 알린다. */
  refuseUpload(ticket: UploadTicket, error: string): boolean {
    if (!this.current(ticket.generation, ticket.session)) return false;
    const state = this.projects.get(ticket.projectId);
    if (!state?.draft.uploads.some((u) => u.key === ticket.key)) return false;
    this.patchDraft(ticket.projectId, (d) => ({ ...d, uploads: d.uploads.filter((u) => u.key !== ticket.key), error }));
    return true;
  }
  finishUpload(ticket: UploadTicket, attachment: Attachment | null, error: string | null = null): boolean {
    if (!this.current(ticket.generation, ticket.session)) return false;
    const state = this.projects.get(ticket.projectId);
    if (!state?.draft.uploads.some((u) => u.key === ticket.key)) return false;
    this.patchDraft(ticket.projectId, (d) => ({ ...d, uploads: d.uploads.map((u) => u.key === ticket.key ? { ...u, attachment, failed: !attachment } : u), error: error ? `${d.uploads.find((u) => u.key === ticket.key)!.name}: ${error}. 파일을 빼고 다시 선택해 주세요` : d.error }));
    return true;
  }

  /** Authentication rotation fences old completions while keeping recovery data. */
  invalidate(): void {
    this.generation++;
    this.checks.clear();
    this.sends.clear();
    this.firstSends.clear();
    for (const [projectId, state] of this.projects) {
      const interrupted = state.draft.uploads.some((u) => !u.attachment && !u.failed);
      this.projects.set(projectId, { ...state, draft: interrupted ? { ...state.draft, uploads: state.draft.uploads.map((u) => !u.attachment ? { ...u, failed: true } : u), error: uploadRecovery } : state.draft, attempts: state.attempts.map((a) => freezeAttempt({ ...a, status: "retryable", error: "접속을 확인한 뒤 전송 결과를 다시 확인해 주세요" })) });
    }
    this.emit();
  }
  /** Only explicit logout erases local drafts and immutable attempts. */
  clear(): void {
    this.invalidate();
    try {
      const keys: string[] = [];
      for (let i = 0; i < this.options.storage.length; i++) { const key = this.options.storage.key(i); if (key?.startsWith(this.prefix)) keys.push(key); }
      for (const key of keys) this.options.storage.removeItem(key);
    } catch { /* In-memory completions remain fenced if storage itself is denied. */ }
    this.projects.clear();
    this.migrations.clear();
    this.emit();
  }
  /** storage events update visible attempts; correctness does not depend on them. */
  refreshStoredAttempts(): void { for (const projectId of this.projects.keys()) this.syncAttempts(projectId, true); }

  private key(projectId: string): string { return this.prefix + this.scope + encodeURIComponent(projectId); }
  private attemptPrefix(projectId: string): string { return `${this.prefix}attempt:${this.scope || "project:"}${encodeURIComponent(projectId)}:`; }
  private attemptKey(projectId: string, id: string): string { return this.attemptPrefix(projectId) + encodeURIComponent(id); }
  private current(generation: number, session: string | number | null): boolean { return generation === this.generation && session === this.options.session(); }
  private find(projectId: string, id: string): MessageAttempt | undefined { return this.projects.get(projectId)?.attempts.find((a) => a.id === id); }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private replace(projectId: string, state: ProjectDraft): void { this.projects.set(projectId, state); this.emit(); }
  private readAttempts(projectId: string, fallback: readonly MessageAttempt[] = []): MessageAttempt[] {
    const found = new Map<string, MessageAttempt>();
    for (let i = 0; i < this.options.storage.length; i++) {
      const key = this.options.storage.key(i);
      if (!key?.startsWith(this.attemptPrefix(projectId))) continue;
      const raw = this.options.storage.getItem(key);
      if (!raw) continue;
      try {
        const a = JSON.parse(raw);
        if (validAttempt(a, projectId)) found.set(a.id, fallback.find((old) => old.id === a.id) ?? freezeAttempt({ ...a, sourceRevision: a.sourceRevision ?? null, status: "checking", error: null }));
      } catch { /* One corrupt attempt cannot hide other recoverable requests. */ }
    }
    for (const a of this.migrations.get(projectId) ?? []) if (!found.has(a.id)) found.set(a.id, a);
    return [...found.values()];
  }
  private syncAttempts(projectId: string, notify = false): ProjectDraft {
    const state = this.snapshot(projectId);
    try {
      const attempts = this.readAttempts(projectId, state.attempts);
      const capturedSource = attempts.some((attempt) => attempt.sourceRevision === state.revision);
      if (!capturedSource && attempts.length === state.attempts.length && attempts.every((a, i) => a === state.attempts[i])) return state;
      const next = capturedSource ? { ...state, attempts, draft: emptyDraft(), revision: revision() } : { ...state, attempts };
      this.projects.set(projectId, next);
      if (notify || capturedSource) this.emit();
      return next;
    } catch { return state; }
  }
  private migrateAttempts(projectId: string): boolean {
    const pending = this.migrations.get(projectId) ?? [];
    try {
      for (const a of pending) if (!this.options.storage.getItem(this.attemptKey(projectId, a.id))) this.options.storage.setItem(this.attemptKey(projectId, a.id), JSON.stringify(a));
      this.migrations.delete(projectId);
      return true;
    } catch { return false; }
  }
  private writeDraft(projectId: string, state: ProjectDraft, expectedRevision?: string): boolean {
    try {
      if (!this.migrateAttempts(projectId)) return false;
      const raw = this.options.storage.getItem(this.key(projectId));
      const stored = raw ? JSON.parse(raw) : null;
      // A tab that has not loaded a version-one record may still be the next writer.
      // Extract its attempts before dropping the old embedded array.
      if (Array.isArray(stored?.attempts)) {
        for (const a of stored.attempts) if (validAttempt(a, projectId) && !this.options.storage.getItem(this.attemptKey(projectId, a.id))) this.options.storage.setItem(this.attemptKey(projectId, a.id), JSON.stringify({ ...a, sourceRevision: null }));
      }
      if (expectedRevision !== undefined && stored?.revision && stored.revision !== expectedRevision) return true;
      this.options.storage.setItem(this.key(projectId), JSON.stringify({ version: 2, draft: state.draft, revision: state.revision }));
      return true;
    } catch { return false; }
  }
  private legacyRetry(projectId: string, retry: { id: string; text?: unknown; signature?: unknown }, uploads: Upload[]): MessageAttempt | null {
    try {
      const direct = this.options.direct;
      const [text, targetMemberId, attachmentIds] = direct ? [retry.text, direct.targetMemberId, []] : JSON.parse(String(retry.signature));
      if (typeof text !== "string" || !(targetMemberId === null || typeof targetMemberId === "string") || !Array.isArray(attachmentIds) || !attachmentIds.every((id) => typeof id === "string")) return null;
      return freezeAttempt({ id: retry.id, projectId, payload: { id: retry.id, text, targetMemberId, attachmentIds }, targetName: direct?.targetName ?? null, attachments: uploads.flatMap((u) => u.attachment && attachmentIds.includes(u.attachment.id) ? [u.attachment] : []), sourceRevision: null, status: "checking", error: null });
    } catch { return null; }
  }
  private updateAttempt(attempt: MessageAttempt, patch: Partial<Pick<MessageAttempt, "status" | "error">>): void {
    const state = this.projects.get(attempt.projectId);
    if (state?.attempts.some((a) => a.id === attempt.id)) this.replace(attempt.projectId, { ...state, attempts: state.attempts.map((a) => a.id === attempt.id ? freezeAttempt({ ...a, ...patch }) : a) });
    // Status is intentionally memory-only. Rewriting a per-ID key here could revive
    // an attempt another tab settled between reading and writing it.
  }
  private settle(attempt: MessageAttempt, message: Message): boolean {
    if (message.id !== attempt.id || message.projectId !== attempt.projectId || !message.mine) {
      this.updateAttempt(attempt, { status: "retryable", error: "전송 결과가 요청과 일치하지 않습니다. 다시 확인해 주세요" });
      return false;
    }
    this.options.accepted(message);
    if (message.delivery === "failed") {
      this.updateAttempt(attempt, { status: "retryable", error: message.deliveryNote ?? "전달하지 못했습니다. 같은 내용으로 다시 시도할 수 있습니다" });
      return false;
    }
    const state = this.projects.get(attempt.projectId);
    try {
      const raw = this.options.storage.getItem(this.key(attempt.projectId));
      const stored = raw ? JSON.parse(raw) : null;
      const sourceStillOnDisk = attempt.sourceRevision && stored?.revision === attempt.sourceRevision;
      // An embedded version-one array must also be removed durably before its
      // independent key can be settled, or the next reload would migrate it again.
      if (state && (sourceStillOnDisk || (stored && stored.version !== 2)) && !this.writeDraft(attempt.projectId, state, sourceStillOnDisk ? attempt.sourceRevision! : undefined)) throw new Error("draft storage unavailable");
      this.options.storage.removeItem(this.attemptKey(attempt.projectId, attempt.id));
      if (state) this.replace(attempt.projectId, { ...state, attempts: state.attempts.filter((a) => a.id !== attempt.id) });
    } catch {
      this.updateAttempt(attempt, { status: "retryable", error: "전송은 확인했습니다. 기기 저장 공간을 확보한 뒤 다시 확인해 주세요" });
    }
    return true;
  }
  private check(attempt: MessageAttempt): Promise<boolean> {
    const known = this.checks.get(attempt.id);
    if (known) return known;
    if (this.sends.has(attempt.id)) return Promise.resolve(false);
    const generation = this.generation, session = this.options.session();
    this.updateAttempt(attempt, { status: "checking", error: null });
    const pending = (async () => {
      try {
        const message = await this.options.lookup(attempt.id);
        if (this.current(generation, session) && this.find(attempt.projectId, attempt.id)) return this.settle(attempt, message);
      } catch (error) {
        if (this.current(generation, session)) this.updateAttempt(attempt, { status: "retryable", error: (error as { status?: number })?.status === 404 ? "아직 서버에서 확인되지 않았습니다. 같은 내용으로 다시 시도할 수 있습니다" : `전송 결과를 확인하지 못했습니다: ${readableError(error)}` });
      }
      return false;
    })();
    this.checks.set(attempt.id, pending);
    void pending.finally(() => { if (this.checks.get(attempt.id) === pending) this.checks.delete(attempt.id); });
    return pending;
  }
  private async transmit(attempt: MessageAttempt): Promise<boolean> {
    if (this.sends.has(attempt.id)) return false;
    const generation = this.generation, session = this.options.session();
    const first = this.firstSends.get(attempt.id);
    this.firstSends.delete(attempt.id);
    this.sends.add(attempt.id);
    this.updateAttempt(attempt, { status: first ? "sending" : "checking", error: null });
    let sent: Message | null = null;
    let refused: SubmissionRefused | null = null;
    try { sent = await this.options.send(attempt); }
    catch (error) {
      if (isRefused(error)) refused = error;
      else if (this.current(generation, session)) this.updateAttempt(attempt, { status: "retryable", error: readableError(error) });
    }
    finally { if (this.current(generation, session)) this.sends.delete(attempt.id); }
    if (!this.current(generation, session) || !this.find(attempt.projectId, attempt.id)) return false;
    if (refused) return this.refuse(attempt, refused.message, first);
    return sent ? this.settle(attempt, sent) : this.check(attempt);
  }
  /**
   * 서버가 저장 전에 거부했다. 이 화면에서 처음 보낸 새 id 이고 그 뒤 입력칸이 그대로면 원래 글·대상·첨부를 되돌리고 시도를 지운다.
   * 입력칸이 바뀌었거나 이미 한 번 나간 id 의 재시도(서버에 실패 글로 있을 수 있음)면 되돌리지 않고 같은 내용 재시도로 남긴다.
   */
  private refuse(attempt: MessageAttempt, reason: string, first: { before: Draft; cleared: Draft } | undefined): boolean {
    const state = this.projects.get(attempt.projectId);
    if (!first || !state || state.draft !== first.cleared) {
      this.updateAttempt(attempt, { status: "retryable", error: reason });
      return false;
    }
    // 시도를 먼저 지운다. 지우지 못하면 되돌리지 않는다(다시 열 때 같은 글이 시도와 입력칸에 둘 다 남지 않게).
    try { this.options.storage.removeItem(this.attemptKey(attempt.projectId, attempt.id)); }
    catch {
      this.updateAttempt(attempt, { status: "retryable", error: reason });
      return false;
    }
    const next: ProjectDraft = { draft: { ...first.before, error: `${reason}. 글은 그대로 두었습니다` }, attempts: state.attempts.filter((a) => a.id !== attempt.id), revision: revision() };
    // 다른 탭이 그 사이 입력칸을 바꿨으면 기기에는 그 글을 둔다. 이 화면에는 되돌린 글을 보인다.
    this.writeDraft(attempt.projectId, next, state.revision);
    this.replace(attempt.projectId, next);
    return false;
  }
}
function validUpload(value: unknown): value is Upload {
  if (!value || typeof value !== "object") return false;
  const u = value as Partial<Upload>;
  return typeof u.key === "string" && typeof u.name === "string" && (u.attachment === null || (typeof u.attachment === "object" && typeof u.attachment?.id === "string"));
}
function validAttempt(value: unknown, projectId: string): value is MessageAttempt {
  if (!value || typeof value !== "object") return false;
  const a = value as MessageAttempt;
  return typeof a.id === "string" && a.projectId === projectId && a.payload?.id === a.id && typeof a.payload.text === "string" && (a.payload.targetMemberId === null || typeof a.payload.targetMemberId === "string") && Array.isArray(a.payload.attachmentIds) && a.payload.attachmentIds.every((id) => typeof id === "string") && Array.isArray(a.attachments)
    && (a.payload.taskId === undefined || a.payload.taskId === null || typeof a.payload.taskId === "string");
}
function freezeAttempt(attempt: MessageAttempt): MessageAttempt {
  const frozen = copy(attempt);
  Object.freeze(frozen.payload.attachmentIds); Object.freeze(frozen.payload);
  for (const attachment of frozen.attachments) Object.freeze(attachment);
  Object.freeze(frozen.attachments);
  return Object.freeze(frozen);
}
