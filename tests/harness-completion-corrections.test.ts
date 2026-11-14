// 원보고는 보존하고, 현재 유효한 완료 근거만 실제 post/task_trace 경로에서 판정한다.
import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";
import type { Member } from "../shared/types.ts";

const ONE = { kind: "coding", goal: "정정된 근거를 승계하지 않는다", acceptance: ["유효한 완료가 있다"], checks: ["behavior"] };
const id = (r: { text: string }, prefix = "tk") => r.text.match(new RegExp(`#(${prefix}_[\\w-]+)`))![1]!;
const checks = [{ kind: "behavior", name: "동작", result: "pass", evidence: "격리 성공", command: "bun test corrected", criterion: 1 }];
type F = ReturnType<typeof fixture>;
async function success(f: F, task: string, member = f.worker, corrects?: string, rev = 1) {
  f.ran(member, "bun test corrected");
  const r = await f.tool(member, "post", { task_id: task, kind: "완료", title: "근거 있는 완료", contract_rev: rev, checks, ...(corrects ? { corrects_message_id: corrects } : {}) });
  expect(r.isError).toBeUndefined();
  return id(r, "msg");
}
const inherit = (f: F, task: string) => f.tool(f.lead, "post", { task_id: task, kind: "완료", title: "현재 근거 승계" });
const trace = async (f: F, task: string) => JSON.parse((await f.tool(f.lead, "task_trace", { task_id: task })).text);
const correction = (f: F, task: string, target: string, kind = "막힘", member: Member = f.worker, rev = 1) => f.tool(member, "post", { task_id: task, kind, title: "기존 결과 정정", corrects_message_id: target, contract_rev: rev, checks: [{ ...checks[0], result: "fail", evidence: "통과를 철회함" }] });

for (const kind of ["막힘", "알림"]) test(`완료→${kind}/실패: 총괄 승계와 상위 업무가 정정된 완료를 근거로 쓰지 않는다`, async () => {
  const f = fixture(), parent = id(await f.tool(f.lead, "task", { title: "상위 계약", contract: ONE }));
  const child = id(await f.tool(f.worker, "task", { title: "갈래 구현", parent_task_id: parent }));
  const original = await success(f, child);
  const inherited = await inherit(f, parent);
  expect(inherited.isError).toBeUndefined();
  const corrected = await correction(f, child, original, kind);
  expect(corrected.isError).toBeUndefined();
  expect((await inherit(f, parent)).isError).toBe(true);
  expect((await inherit(f, child)).isError).toBe(true);
  const t = await trace(f, parent);
  expect(t.currentCompletion).toMatchObject({ eligible: false, sources: [] });
  expect(t.reports.find((r: { id: string }) => r.id === original)).toMatchObject({ gate: "contract", completionBasis: { eligible: false, status: "superseded", correctedBy: id(corrected, "msg") } });
  expect(t.reports.find((r: { id: string }) => r.id === id(inherited, "msg"))).toMatchObject({ completionBasis: { eligible: false, status: "missing_basis" } });
  expect(f.store.getMessage(original)?.kind).toBe("완료");
  expect(f.store.getReportHarness(original)?.gate).toBe("contract");
});

test("완료→검사한 새 완료는 새 근거만 승계하고 그 근거 정정 후에는 막힌다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "대체 완료", contract: ONE }));
  const first = await success(f, task), replacement = await success(f, task, f.worker, first);
  expect((await inherit(f, task)).isError).toBeUndefined();
  let t = await trace(f, task);
  expect(t.currentCompletion).toMatchObject({ eligible: true, sources: [replacement] });
  expect(t.reports.find((r: { id: string }) => r.id === first).completionBasis.status).toBe("superseded");
  await correction(f, task, replacement);
  expect((await inherit(f, task)).isError).toBe(true);
  t = await trace(f, task);
  expect(t.currentCompletion.eligible).toBe(false);
});

test("연속 정정은 옛 통과를 되살리지 않고 새 검사 완료 뒤에만 다시 승계한다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "연속 정정", contract: ONE }));
  const first = await success(f, task);
  const blocked = id(await correction(f, task, first), "msg");
  const second = id(await correction(f, task, blocked, "진행"), "msg");
  expect((await inherit(f, task)).isError).toBe(true);
  const latest = await success(f, task, f.worker, second);
  expect((await inherit(f, task)).isError).toBeUndefined();
  const t = await trace(f, task);
  expect(t.currentCompletion.sources).toEqual([latest]);
  expect(t.reports.find((r: { id: string }) => r.id === first).completionBasis.status).toBe("superseded");
  expect(t.reports.find((r: { id: string }) => r.id === second).correctsMessageId).toBe(blocked);
});

test("무관한 막힘과 다른 직원의 정정 시도는 유효 완료를 취소하지 못한다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "권한 경계", contract: ONE }));
  const first = await success(f, task);
  const denied = await correction(f, task, first, "막힘", f.worker2);
  expect(denied.isError).toBe(true);
  expect(denied.text).toContain("자신이 작성한 보고만");
  expect((await f.tool(f.worker, "post", { task_id: task, kind: "막힘", title: "무관한 어려움", body: first })).isError).toBeUndefined();
  expect((await inherit(f, task)).isError).toBeUndefined();
  expect((await trace(f, task)).currentCompletion.sources).toEqual([first]);
});

test("같은 직원의 다른 갈래 업무 정정은 원 업무 통과를 취소하지 않는다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "업무 경계", contract: ONE }));
  const a = id(await f.tool(f.worker, "task", { title: "갈래 A", parent_task_id: task }));
  const b = id(await f.tool(f.worker, "task", { title: "갈래 B", parent_task_id: task }));
  const first = await success(f, a);
  const out = await correction(f, b, first);
  // 현재 게시 API는 명시 업무를 우선한다. 다른 업무의 정정 링크는 근거 취소 권한이 아니다.
  expect(out.isError).toBeUndefined();
  expect((await inherit(f, task)).isError).toBeUndefined();
  expect((await trace(f, task)).currentCompletion.sources).toEqual([first]);
});

test("다른 계약 판 정정은 이전 판 근거를 취소하지 않고 이전 판은 현 판 승계에 쓰지 않는다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "판 경계", contract: ONE }));
  const first = await success(f, task);
  await f.tool(f.lead, "task", { task_id: task, contract: { ...ONE, goal: "새 판 검증" } });
  expect((await correction(f, task, first, "막힘", f.worker, 2)).isError).toBeUndefined();
  expect(f.store.hasPassedCompletion(task, 1)).toBe(true);
  expect((await inherit(f, task)).isError).toBe(true);
  let t = await trace(f, task);
  expect(t.reports.find((r: { id: string }) => r.id === first).completionBasis.status).toBe("not_current");
  const current = await success(f, task, f.worker, undefined, 2);
  expect((await inherit(f, task)).isError).toBeUndefined();
  t = await trace(f, task);
  expect(t.currentCompletion.sources).toEqual([current]);
});

test("한 직원의 정정은 다른 직원이 검사한 정상 완료를 취소하지 않는다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "다른 정상 근거", contract: ONE }));
  const a = await success(f, task), b = await success(f, task, f.worker2);
  await correction(f, task, a);
  expect((await inherit(f, task)).isError).toBeUndefined();
  expect((await trace(f, task)).currentCompletion.sources).toEqual([b]);
});

test("기존 행의 권한 없는 정정 링크도 완료 근거를 취소하지 못한다", async () => {
  const f = fixture(), task = id(await f.tool(f.lead, "task", { title: "기존 행 경계", contract: ONE }));
  const first = await success(f, task);
  const foreign = id(await f.tool(f.worker2, "post", { task_id: task, kind: "막힘", title: "다른 직원 기록" }), "msg");
  // 격리 DB에만 과거의 잘못된 연결을 주입한다. 현재 게시 API는 이 연결을 거절한다.
  f.store.db.query("UPDATE report_references SET corrects_message_id = ? WHERE source_message_id = ?").run(first, foreign);
  expect((await inherit(f, task)).isError).toBeUndefined();
  expect((await trace(f, task)).currentCompletion.sources).toEqual([first]);
});
