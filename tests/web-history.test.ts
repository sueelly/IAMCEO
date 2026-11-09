import { describe, expect, test } from "bun:test";
import type { Message, MessagePage } from "../shared/types";
import { CursorHistory, compareMessages } from "../web/src/lib/history";

const msg = (id: string, at = "2026-01-01", extra: Partial<Message> = {}): Message => ({
  id, at, projectId: "p", mine: false, memberId: null, who: "", kind: "진행", title: "", body: id,
  targetMemberId: null, targetName: null, decisionId: null, fileId: null, attachments: [], delivery: null, deliveryNote: null, ...extra,
});
const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => msg(String(from + i).padStart(4, "0")));
const page = (items: Message[], nextCursor: string | null = null): MessagePage => ({ projectId: "p", scope: { kind: "project" }, items, nextCursor, hasOlder: nextCursor !== null });
function initial(h: CursorHistory, items: Message[], cursor: string | null = null) { const r = h.begin("initial")!; expect(h.apply(page(items, cursor), r)).toBe(true); }

describe("cursor history", () => {
  test("first 200 and earlier 100 use opaque cursors with binary timestamp/id ordering", () => {
    const h = new CursorHistory("p"); const first = h.begin("initial")!; expect(first.limit).toBe(200);
    expect(h.apply(page([msg("z"), msg("a"), msg("é"), msg("é"), msg("😀"), msg("\uE000")], "opaque-1"), first)).toBe(true);
    expect(h.items.map((m) => m.id)).toEqual(["a", "é", "z", "é", "\uE000", "😀"]);
    const older = h.begin("older")!; expect(older.limit).toBe(100); expect(older.cursor).toBe("opaque-1");
    expect(h.apply(page([msg("0"), msg("a", undefined, { body: "new" })]), older)).toBe(true);
    expect(h.items.filter((m) => m.id === "a")).toHaveLength(1); expect(h.hasOlder).toBe(false);
  });

  test("a >200-row reconnect gap stages pages until it overlaps existing history", () => {
    const h = new CursorHistory("p"); initial(h, rows(0, 100), "old-cursor");
    h.apply(page(rows(400, 600), "c400"), h.begin("latest")!);
    expect(h.items).toHaveLength(100); expect(h.isBridging).toBe(true);
    h.apply(page(rows(300, 400), "c300"), h.begin("bridge")!);
    h.apply(page(rows(200, 300), "c200"), h.begin("bridge")!);
    h.apply(page(rows(100, 200), "c100"), h.begin("bridge")!);
    expect(h.items).toHaveLength(100);
    h.apply(page(rows(0, 100)), h.begin("bridge")!);
    expect(h.items.map((m) => m.id)).toEqual(rows(0, 600).map((m) => m.id));
    expect(h.isBridging).toBe(false); expect(h.nextCursor).toBe("old-cursor");
  });

  for (const arrival of ["before latest", "during latest", "during previous read"] as const) {
    test(`a disconnected live tail ${arrival} cannot prove a reconnect gap is contiguous`, () => {
      const h = new CursorHistory("p"); initial(h, rows(0, 100));
      if (arrival === "before latest") h.receive(msg("0600"));
      if (arrival === "during previous read") {
        const earlier = h.begin("latest")!;
        h.receive(msg("0600"));
        h.apply(page(rows(0, 200)), earlier);
      }
      const latest = h.begin("latest")!;
      if (arrival === "during latest") h.receive(msg("0600"));
      h.apply(page(rows(401, 601), "c401"), latest);
      expect(h.isBridging).toBe(true);
      expect(h.items.some((message) => message.id === "0401")).toBe(false);
      h.apply(page(rows(301, 401), "c301"), h.begin("bridge")!);
      h.apply(page(rows(201, 301), "c201"), h.begin("bridge")!);
      h.apply(page(rows(101, 201), "c101"), h.begin("bridge")!);
      if (h.isBridging) h.apply(page(rows(1, 101), "c1"), h.begin("bridge")!);
      expect(h.isBridging).toBe(false);
      expect(h.items.map((message) => message.id)).toEqual(rows(0, 601).map((message) => message.id));
    });
  }

  test("failed bridging and repeated cursors retain visible data and allow an explicit retry", () => {
    const h = new CursorHistory("p"); initial(h, rows(0, 10), "old");
    h.apply(page(rows(200, 400), "c200"), h.begin("latest")!);
    const bridge = h.begin("bridge")!; h.fail(new Error("offline"), bridge);
    expect(h.items).toHaveLength(10); expect(h.error).toContain("offline");
    const retry = h.begin("bridge")!;
    expect(h.apply(page(rows(100, 200), "c200"), retry)).toBe(false);
    expect(h.items).toHaveLength(10); expect(h.nextCursor).toBe("old");
  });
  test("older continuations reject a cursor cycle across several pages", () => {
    const h = new CursorHistory("p"); initial(h, rows(300, 400), "c300");
    h.apply(page(rows(200, 300), "c200"), h.begin("older")!);
    expect(h.apply(page(rows(100, 200), "c300"), h.begin("older")!)).toBe(false);
    expect(h.items).toHaveLength(200); expect(h.nextCursor).toBe("c200");
  });

  test("local attempts and events received during reads survive stale pages", () => {
    const h = new CursorHistory("p"); initial(h, [msg("a")], "old");
    const request = h.begin("latest")!;
    h.receive(msg("a", undefined, { delivery: "delivered" }));
    h.receive(msg("b")); h.receive(msg("draft", undefined, { mine: true, delivery: "queued" }), true);
    h.apply(page([msg("a", undefined, { delivery: "queued" })]), request);
    expect(h.items.find((m) => m.id === "a")?.delivery).toBe("delivered");
    expect(h.items.map((m) => m.id)).toEqual(["a", "b", "draft"]);
  });

  test("cancelled generation, wrong scope and foreign rows cannot mutate history", () => {
    const h = new CursorHistory("p"); const obsolete = h.begin("initial")!; h.cancel();
    expect(h.apply(page([msg("late")]), obsolete)).toBe(false); expect(h.items).toEqual([]);
    const request = h.begin("initial")!;
    expect(h.apply({ ...page([msg("bad")]), scope: { kind: "member", memberId: "m" } }, request)).toBe(false);
    expect(h.items).toEqual([]);
    expect(h.apply(page([msg("bad", undefined, { projectId: "other" })]), h.begin("initial")!)).toBe(false);
    expect(h.items).toEqual([]);
  });

  test("server history replacement without an anchor leaves old rows visible with an error", () => {
    const h = new CursorHistory("p"); initial(h, rows(0, 10));
    h.apply(page(rows(20, 30)), h.begin("latest")!);
    expect(h.items.map((m) => m.id)).toEqual(rows(0, 10).map((m) => m.id));
    expect(h.error).toContain("변경"); expect(h.isBridging).toBe(false);
  });
  test("a truncated complete page with one surviving anchor still cannot erase stored rows", () => {
    const h = new CursorHistory("p"); initial(h, rows(0, 10));
    h.apply(page(rows(9, 20)), h.begin("latest")!);
    expect(h.items.map((m) => m.id)).toEqual(rows(0, 10).map((m) => m.id));
    expect(h.error).toContain("변경");
  });

  test("tie comparator matches SQLite BINARY and never normalizes distinct IDs", () => {
    expect(compareMessages(msg("\uE000"), msg("😀"))).toBeLessThan(0);
    expect(compareMessages(msg("é"), msg("é"))).not.toBe(0);
  });
});
