import { describe, expect, test } from "bun:test";
import { shareJSON } from "../web/src/lib/structural-sharing";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("JSON domain structural sharing", () => {
  test("equal payloads keep the previous root and identical references return immediately", () => {
    const previous = freeze({ members: [{ id: "a", status: "idle", configRevision: 4 }], files: [], connection: { ok: true } });
    expect(shareJSON(previous, structuredClone(previous))).toBe(previous);
    expect(shareJSON(previous, previous)).toBe(previous);
  });

  test("runtime changes apply with equal configuration revisions while siblings keep their references", () => {
    const previous = freeze({
      members: [{ id: "a", status: "idle", now: "", configRevision: 4, context: { tokens: 10 } }, { id: "b", status: "idle", configRevision: 2 }],
      files: [{ id: "f", title: "Read me" }],
    });
    const incoming = freeze({ ...structuredClone(previous), members: [
      { ...structuredClone(previous.members[0]), status: "working", now: "reading" }, structuredClone(previous.members[1]),
    ] });
    const result = shareJSON(previous, incoming);
    expect(result).toEqual(incoming);
    expect(result).not.toBe(previous);
    expect(result.members).not.toBe(previous.members);
    expect(result.members[0]).not.toBe(previous.members[0]);
    expect(result.members[0].context).toBe(previous.members[0].context);
    expect(result.members[1]).toBe(previous.members[1]);
    expect(result.files).toBe(previous.files);
    expect(previous.members[0].status).toBe("idle");
    expect(incoming.members[0].status).toBe("working");
  });

  test("reordered keyed rows keep equal row references in the incoming order", () => {
    const previous = freeze([{ id: "a", value: 1 }, { id: "b", value: 2 }, { id: "c", value: 3 }]);
    const incoming = freeze([{ id: "c", value: 3 }, { id: "a", value: 1 }, { id: "b", value: 2 }]);
    const result = shareJSON(previous, incoming);
    expect(result).toEqual([{ id: "c", value: 3 }, { id: "a", value: 1 }, { id: "b", value: 2 }]);
    expect(result[0]).toBe(previous[2]);
    expect(result[1]).toBe(previous[0]);
    expect(result[2]).toBe(previous[1]);
    expect(previous.map(row => row.id)).toEqual(["a", "b", "c"]);
    expect(incoming[0]).not.toBe(previous[2]);
  });

  test("keyed additions and removals reuse survivors without retaining removed rows", () => {
    const previous = freeze([{ id: "a", tags: ["old"] }, { id: "b", tags: ["keep"] }]);
    const incoming = freeze([{ id: "b", tags: ["keep"] }, { id: "d", tags: ["new"] }]);
    const result = shareJSON(previous, incoming);
    expect(result).toEqual([{ id: "b", tags: ["keep"] }, { id: "d", tags: ["new"] }]);
    expect(result[0]).toBe(previous[1]);
    expect(result[1]).toBe(incoming[1]);
    expect(shareJSON(previous, [])).toEqual([]);
  });

  test("removed and newly undefined fields remain distinct from missing and null fields", () => {
    const previous = freeze({ keep: { ok: true }, remove: "gone", nullable: null, optional: undefined });
    const incoming = freeze({ keep: { ok: true }, nullable: undefined, added: undefined });
    const result = shareJSON(previous, incoming);
    expect(result).toEqual(incoming);
    expect(result.keep).toBe(previous.keep);
    expect(Object.hasOwn(result, "remove")).toBe(false);
    expect(Object.hasOwn(result, "optional")).toBe(false);
    expect(Object.hasOwn(result, "added")).toBe(true);
    expect(result.nullable).toBeUndefined();
    expect(shareJSON({ a: undefined }, { b: undefined })).toEqual({ b: undefined });
    expect(Object.hasOwn(shareJSON({}, { a: undefined }), "a")).toBe(true);
  });

  test("primitive, null, undefined and shape changes use incoming values", () => {
    for (const [previous, incoming] of [[null, undefined], [undefined, null], [3, 4], ["a", "b"], [false, true], [{ a: 1 }, []], [[], { a: 1 }]]) {
      expect(shareJSON(previous, incoming)).toEqual(incoming);
    }
    expect(shareJSON([null], [undefined])).toEqual([undefined]);
    expect(shareJSON([], [undefined])).toHaveLength(1);
    expect(shareJSON([1, 2, 3], [1, 2])).toEqual([1, 2]);
    const previous = freeze([{ nested: [1, null] }, 2]);
    const incoming = freeze([{ nested: [1, null] }, 3]);
    expect(shareJSON(previous, incoming)[0]).toBe(previous[0]);
  });

  test("plain objects with a JSON __proto__ property retain data without changing prototypes", () => {
    const previous = freeze(JSON.parse('{"__proto__":{"value":1},"keep":true}'));
    const incoming = freeze(JSON.parse('{"__proto__":{"value":2},"keep":true}'));
    const result = shareJSON(previous, incoming);
    expect(result).toEqual(incoming);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(previous.__proto__.value).toBe(1);
  });
});
