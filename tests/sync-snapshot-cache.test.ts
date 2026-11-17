import { expect, test } from "bun:test";
import { SyncSnapshotCache } from "../server/sync-snapshot-cache";

test("expiry does not slide when frequently read", () => {
  let now = 0;
  const cache = new SyncSnapshotCache({ now: () => now, ttlMs: 250 });
  cache.set("a", "one"); now = 200; expect(cache.get("a")).toBe("one");
  now = 250; expect(cache.get("a")).toBeUndefined();
});
test("eviction respects least-recently-used entries and UTF-8 bytes", () => {
  const cache = new SyncSnapshotCache({ maxEntries: 2, maxBytes: 12 });
  cache.set("a", "한글"); cache.set("b", "한글");
  expect(cache.get("a")).toBe("한글"); cache.set("c", "a");
  expect(cache.get("b")).toBeUndefined(); expect(cache.get("a")).toBe("한글");
  cache.set("d", "한글한");
  expect(cache.get("a")).toBeUndefined(); expect(cache.get("d")).toBe("한글한");
});
test("an oversized replacement cannot leave stale bytes, and expired entries release capacity", () => {
  let now = 0;
  const cache = new SyncSnapshotCache({ now: () => now, ttlMs: 10, maxBytes: 5, maxEntries: 2 });
  cache.set("a", "123"); cache.set("a", "123456"); expect(cache.get("a")).toBeUndefined();
  cache.set("a", "12345"); now = 10; cache.set("b", "12345");
  expect(cache.get("b")).toBe("12345"); expect(cache.get("a")).toBeUndefined();
});
