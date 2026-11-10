// A8 Hindsight 접점. 실제 Hindsight 에 연결하지 않는다(대역만). 미설정이면 외부 호출 0건.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HINDSIGHT, buildSearchContext } from "../server/integrations/hindsight.ts";
import { WorkService } from "../server/work.ts";

const open: WorkService[] = [];
afterEach(() => { for (const s of open.splice(0)) s.close(); });
function make() {
  const s = new WorkService({ dbPath: join(mkdtempSync(join(tmpdir(), "hs-")), "w.db"), delayMs: 5 });
  open.push(s);
  return s;
}
const trip = (s: WorkService) => s.state().tasks.find((t) => t.title === "출장 동선 조사")!;
const records = (s: WorkService, taskId: string) => s.state().hindsight.records.filter((r) => r.taskId === taskId);

describe("A8 Hindsight 접점", () => {
  test("미설정이면 '연결 전'으로 남고 외부 호출 없이 업무 흐름이 계속된다", async () => {
    const s = make();
    const t = trip(s);
    s.complete(t.id);
    await s.settled();
    const rs = records(s, t.id);
    expect(rs.map((r) => r.kind).sort()).toEqual(["retrospective", "verified_record"]);
    expect(rs.every((r) => r.status === "not_configured" && r.adapter === "none" && r.attempts === 0)).toBe(true);
    expect(s.testAdapters.size).toBe(0);
    expect(s.state().hindsight.uploadState).toContain("연결 전");
    s.resume(t.id, "다시 봐 주세요"); // 흐름은 막히지 않는다
    expect(s.detail(t.id).task.status).toBe("working");
  });

  test("시험 대역 성공·실패·응답 유실을 구분하고, 유실은 자동으로 새 키를 만들지 않으며 같은 판 재시도는 중복이 아니다", async () => {
    const s = make();
    const t = trip(s);
    s.setHindsight({ ...DEFAULT_HINDSIGHT, upload: { mode: "test_lost", endpointRef: null, authRef: null } });
    s.complete(t.id);
    await s.settled();
    const lost = records(s, t.id);
    expect(lost.every((r) => r.status === "unknown" && r.adapter === "test" && r.attempts === 1)).toBe(true);
    const adapter = s.testAdapters.get("test")!;
    expect(adapter.received.size).toBe(2);
    const keys = lost.map((r) => r.idempotencyKey);
    expect(keys.every((k) => k.startsWith(`${s.instanceId}:${t.id}:`) && k.endsWith(":1"))).toBe(true);
    s.setHindsight({ ...DEFAULT_HINDSIGHT, upload: { mode: "test_success", endpointRef: null, authRef: null } });
    for (const r of lost) await s.retryRecord(r.id);
    const ok = records(s, t.id);
    expect(ok.every((r) => r.status === "uploaded" && r.receipt?.startsWith("test-receipt-"))).toBe(true);
    expect(adapter.received.size).toBe(2); // 같은 키라 대역 서버에 새로 생기지 않았다
    expect(ok.map((r) => r.idempotencyKey)).toEqual(keys);
    await expect(s.retryRecord(ok[0]!.id)).rejects.toThrow("이미 올라간");
    // 실패
    s.setHindsight({ ...DEFAULT_HINDSIGHT, upload: { mode: "test_fail", endpointRef: null, authRef: null } });
    s.resume(t.id); s.complete(t.id);
    await s.settled();
    const second = records(s, t.id).filter((r) => r.revision === 2);
    expect(second.every((r) => r.status === "failed")).toBe(true);
    expect(second.every((r) => r.idempotencyKey.endsWith(":2"))).toBe(true);
  });

  test("실제 서버 모드는 계약을 받기 전이라 보내지 않고, 시험 성공을 실제 성공으로 표시하지 않는다", async () => {
    const s = make();
    const t = trip(s);
    s.setHindsight({ ...DEFAULT_HINDSIGHT, upload: { mode: "external", endpointRef: "env:HINDSIGHT_URL", authRef: "env:HINDSIGHT_TOKEN" } });
    s.complete(t.id);
    await s.settled();
    expect(records(s, t.id).every((r) => r.status === "not_configured" && r.adapter === "external" && r.lastError?.includes("계약"))).toBe(true);
    expect(s.state().hindsight.uploadState).toContain("실제 계약 미확인");
    expect(() => s.setHindsight({ ...DEFAULT_HINDSIGHT, upload: { mode: "external", endpointRef: null, authRef: "sk-live-secret-value" } })).toThrow("참조 이름");
  });

  test("검색 바인딩은 실행 입력마다 업무 범위로 전달되고, 설정돼도 '미확인'으로만 표시한다", async () => {
    const none = buildSearchContext({ trialInstanceId: "i", projectId: "p", taskId: "t", roleId: "r", sourceRefs: ["task:t"] }, DEFAULT_HINDSIGHT.search);
    expect(none).toMatchObject({ bindingRef: null, status: "not_configured", scope: { trialInstanceId: "i", projectRef: "p", taskRef: "t", roleRef: "r" } });
    const s = make();
    s.setHindsight({ ...DEFAULT_HINDSIGHT, search: { ...DEFAULT_HINDSIGHT.search, mcpServerRef: "hindsight", toolRef: "search_memory" } });
    expect(s.state().hindsight.searchState).toContain("미확인");
    const t = trip(s);
    s.send(t.id, { text: "범위 확인" });
    const input = s.inputsOf(s.detail(t.id).task.activeRunId!).at(-1)!;
    expect(input.searchContext).toMatchObject({ bindingRef: "hindsight#search_memory", status: "configured_unverified", scope: { taskRef: t.id, projectRef: t.projectId } });
    expect(input.searchContext!.sourceRefs).toContain(`task:${t.id}`);
  });
});
