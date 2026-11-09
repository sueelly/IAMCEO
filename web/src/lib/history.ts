import type { Message, MessagePage } from "@shared/types";

const encoder = new TextEncoder();
/** SQLite BINARY compares UTF-8 bytes, including timestamps and unnormalized IDs. */
function binary(a: string, b: string): number {
  if (a === b) return 0;
  const left = encoder.encode(a), right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
export const compareMessages = (a: Message, b: Message): number => binary(a.at, b.at) || binary(a.id, b.id);
export const orderedMessages = (rows: Iterable<Message>): Message[] => [...rows].sort(compareMessages);
export function mergeHistoryMessages(local: Message[], fresh: Message[]): Message[] {
  return orderedMessages(new Map([...local, ...fresh].map((m) => [m.id, m])).values());
}

export type HistoryLoad = "initial" | "latest" | "older" | "bridge";
export interface HistoryRequest { generation: number; id: number; kind: HistoryLoad; cursor?: string; limit: number }
interface Bridge { rows: Map<string, Message>; provenIDs: Set<string>; cursor: string | null; anchors: Set<string>; seenCursors: Set<string> }

/** Only publish a new tail after cursor pages prove it joins the visible interval. */
export class CursorHistory {
  initialized = false;
  hasOlder = false;
  nextCursor: string | null = null;
  error: string | null = null;
  private generation = 0;
  private requestID = 0;
  private loading: HistoryRequest | null = null;
  private confirmed = new Map<string, Message>();
  /** Live rows may be visible without proving the interval before them is complete. */
  private contiguousIDs = new Set<string>();
  private optimistic = new Map<string, Message>();
  private overlay = new Map<string, Message>();
  private journal: Message[] = [];
  private bridge: Bridge | null = null;
  private changed = false;
  private olderCursors = new Set<string>();

  constructor(readonly projectId: string) {}
  get items(): Message[] { return mergeHistoryMessages([...this.optimistic.values()], [...this.confirmed.values()]); }
  get isBridging(): boolean { return this.bridge !== null; }
  get isLoading(): boolean { return this.loading !== null; }
  get needsReset(): boolean { return this.changed; }
  removeOptimistic(id: string): void { this.optimistic.delete(id); }

  receive(message: Message, local = false): void {
    if (message.projectId !== this.projectId) return;
    if (local && !this.confirmed.has(message.id)) {
      this.optimistic.set(message.id, message);
      return;
    }
    if (this.loading) this.journal.push(message);
    if (this.confirmed.has(message.id)) {
      this.confirmed.set(message.id, message);
      this.optimistic.delete(message.id);
    } else if (this.bridge || this.loading?.kind === "initial" || this.loading?.kind === "latest") {
      this.overlay.set(message.id, message);
      if (this.bridge?.rows.has(message.id)) this.bridge.rows.set(message.id, message);
    } else {
      const tail = orderedMessages(this.confirmed.values()).at(-1);
      if (this.initialized && (!tail || compareMessages(tail, message) < 0)) {
        this.confirmed.set(message.id, message);
        this.optimistic.delete(message.id);
      } else this.overlay.set(message.id, message);
    }
  }

  begin(kind: HistoryLoad): HistoryRequest | null {
    if (this.loading || this.changed) return null;
    if (kind === "initial" && this.initialized || kind === "latest" && (!this.initialized || this.bridge)
      || kind === "older" && (!this.initialized || this.bridge || !this.hasOlder || !this.nextCursor)
      || kind === "bridge" && !this.bridge?.cursor) return null;
    const cursor = kind === "older" ? this.nextCursor : kind === "bridge" ? this.bridge?.cursor : undefined;
    const request = { generation: this.generation, id: ++this.requestID, kind, cursor: cursor ?? undefined, limit: kind === "initial" || kind === "latest" ? 200 : 100 };
    this.loading = request; this.journal = []; this.error = null;
    return request;
  }

  apply(page: MessagePage, request: HistoryRequest): boolean {
    if (this.loading !== request || request.generation !== this.generation) return false;
    const valid = page.projectId === this.projectId && page.scope?.kind === "project" && Array.isArray(page.items)
      && page.items.length <= request.limit && page.items.every((m) => m.projectId === this.projectId && typeof m.id === "string" && typeof m.at === "string")
      && (page.hasOlder === false && page.nextCursor === null || page.hasOlder === true && page.items.length > 0 && typeof page.nextCursor === "string"
        && page.nextCursor.length > 0 && page.nextCursor !== request.cursor && !this.bridge?.seenCursors.has(page.nextCursor)
        && (request.kind !== "older" || !this.olderCursors.has(page.nextCursor)));
    if (!valid) { this.fail(new Error("대화 기록 응답이 올바르지 않습니다"), request); return false; }
    const rows = new Map(page.items.map((m) => [m.id, this.overlay.get(m.id) ?? m]));
    const pageIDs = new Set(page.items.map((message) => message.id));
    for (const m of this.journal) if (rows.has(m.id)) rows.set(m.id, m);
    const arrivals = this.journal;
    this.loading = null; this.journal = []; this.error = null;
    const overlaps = (anchors: Set<string>) => [...pageIDs].some((id) => anchors.has(id));
    if (request.kind === "initial") {
      this.confirmed = rows; this.initialized = true; this.nextCursor = page.nextCursor; this.hasOlder = page.hasOlder;
      this.contiguousIDs = pageIDs;
      this.olderCursors = new Set(page.nextCursor ? [page.nextCursor] : []);
      this.mergeOverlay(this.confirmed);
    } else if (request.kind === "older") {
      for (const [id, row] of rows) this.confirmed.set(id, row);
      for (const id of pageIDs) this.contiguousIDs.add(id);
      this.nextCursor = page.nextCursor; this.hasOlder = page.hasOlder;
      if (page.nextCursor) this.olderCursors.add(page.nextCursor);
    } else if (request.kind === "latest") {
      if (!page.hasOlder && [...this.contiguousIDs].some((id) => !pageIDs.has(id))) this.storeChanged();
      else if (this.contiguousIDs.size === 0 || overlaps(this.contiguousIDs)) {
        const wasEmpty = this.contiguousIDs.size === 0;
        for (const [id, row] of rows) this.confirmed.set(id, row);
        for (const id of pageIDs) this.contiguousIDs.add(id);
        if (wasEmpty) { this.nextCursor = page.nextCursor; this.hasOlder = page.hasOlder; this.olderCursors = new Set(page.nextCursor ? [page.nextCursor] : []); }
        this.mergeOverlay(this.confirmed);
      } else if (!page.hasOlder) this.storeChanged();
      else {
        this.bridge = { rows, provenIDs: pageIDs, cursor: page.nextCursor, anchors: new Set(this.contiguousIDs), seenCursors: new Set([page.nextCursor!]) };
        this.mergeOverlay(rows);
      }
    } else if (this.bridge) {
      const bridge = this.bridge;
      for (const [id, row] of rows) bridge.rows.set(id, row);
      for (const id of pageIDs) bridge.provenIDs.add(id);
      bridge.cursor = page.nextCursor;
      if (page.nextCursor) bridge.seenCursors.add(page.nextCursor);
      if (overlaps(bridge.anchors)) {
        for (const [id, row] of bridge.rows) this.confirmed.set(id, row);
        for (const id of bridge.provenIDs) this.contiguousIDs.add(id);
        this.mergeOverlay(this.confirmed); this.bridge = null;
      } else if (!page.hasOlder) this.storeChanged();
    }
    for (const message of arrivals) {
      if (this.confirmed.has(message.id)) this.confirmed.set(message.id, message);
      if (this.bridge?.rows.has(message.id)) this.bridge.rows.set(message.id, message);
    }
    for (const id of this.confirmed.keys()) { this.optimistic.delete(id); this.overlay.delete(id); }
    return true;
  }

  fail(error: unknown, request: HistoryRequest): void {
    if (this.loading !== request || request.generation !== this.generation) return;
    this.loading = null; this.journal = [];
    this.error = error instanceof Error ? error.message : String(error);
  }
  cancel(): void { this.generation++; this.loading = null; this.journal = []; }
  private storeChanged(): void { this.changed = true; this.bridge = null; this.error = "서버의 대화 기록이 변경되었습니다. 다시 연결해 주세요"; }
  private mergeOverlay(rows: Map<string, Message>): void {
    const oldest = orderedMessages(rows.values())[0];
    for (const [id, row] of this.overlay) if (rows.has(id) || !oldest || compareMessages(row, oldest) >= 0) {
      rows.set(id, row); this.overlay.delete(id); this.optimistic.delete(id);
    }
  }
}
