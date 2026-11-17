import { describe, expect, test } from "bun:test";
import { TAB_COUNT_CAP, tabCountText } from "../web/src/lib/tab-count";

describe("탭 건수 글", () => {
  test("99 이하는 그대로 보인다", () => {
    for (const n of [1, 7, 12, 99]) expect(tabCountText(n)).toEqual({ shown: String(n), exact: null });
  });
  test("100 이상은 '99+'로 줄이고 정확한 수를 읽어 줄 글로 남긴다", () => {
    expect(TAB_COUNT_CAP).toBe(99);
    expect(tabCountText(100)).toEqual({ shown: "99+", exact: "100건" });
    expect(tabCountText(999)).toEqual({ shown: "99+", exact: "999건" });
    expect(tabCountText(12345)).toEqual({ shown: "99+", exact: "12345건" });
  });
});
