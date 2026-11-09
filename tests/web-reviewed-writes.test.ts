import { expect, test } from "bun:test";
import type { Settings, Todo } from "../shared/types";
import {
  captureWriteReview, executeReviewedWrite, sameDecisionReview, rollbackTodo,
  startSettingsReview, buildSettingsPatch, type WriteContext,
} from "../web/src/lib/reviewed-writes";

const context = (settings = 4): WriteContext => ({
  auth: "ok", credentialGeneration: 1, projectId: "p", syncProjectId: "p",
  capabilities: { contractVersion: 2, capabilities: { paging: true, archive: true, delivery: true, realtime: true, push: false, operations: true } },
  syncRevisions: { settings, members: { m: { configRevision: 6, sessionGeneration: 2 } }, todos: { t: 8 } },
});
const settings = (): Settings => ({
  permissionMode: "default", notifyMac: true, maxConcurrentTurns: 2, compactAtPct: 50, maxAwakeWorkers: 10, boardTidyHours: 3,
  ranks: { manager: { model: "opus", effort: "high" }, lead: { model: "sonnet", effort: "high" }, staff: { model: "haiku", effort: "high" } },
} as Settings);

test("a settings draft sends its reviewed revision after newer sync state arrives", async () => {
  const review = startSettingsReview(settings(), context(4));
  const draft = { numbers: { maxAwakeWorkers: "12" }, ranks: {} };
  const current = context(5);
  const sent: unknown[] = [];
  await executeReviewedWrite(review.write, current, revision => { sent.push([revision, buildSettingsPatch(review.base, draft).patch]); return Promise.resolve("saved"); }, () => { throw new Error("legacy write"); });
  expect(sent).toEqual([[4, { maxAwakeWorkers: 12 }]]);
});

test("strict conflict preserves the edited draft and never retries with a weaker contract", async () => {
  const draft = { numbers: {}, ranks: { lead: { model: "typed-model" } } };
  const review = startSettingsReview(settings(), context());
  const conflict = Object.assign(new Error("review again"), { status: 409 });
  let legacy = 0;
  await expect(executeReviewedWrite(review.write, context(5), async () => { throw conflict; }, async () => { legacy++; })).rejects.toBe(conflict);
  expect(legacy).toBe(0);
  expect(buildSettingsPatch(review.base, draft).patch).toEqual({ ranks: { lead: { model: "typed-model" } } });
});

test("dirty settings leaves do not carry untouched rank fields or newly arrived server values", () => {
  const review = startSettingsReview(settings(), context());
  const draft = { numbers: {}, ranks: { lead: { model: "my-model" } } };
  expect(buildSettingsPatch(review.base, draft).patch).toEqual({ ranks: { lead: { model: "my-model" } } });
  expect(buildSettingsPatch({ ...review.base, notifyMac: false, maxAwakeWorkers: 20 }, draft).patch).toEqual({ ranks: { lead: { model: "my-model" } } });
});

test("member model typing retains the original config revision", async () => {
  const started = captureWriteReview(context(), { kind: "member", projectId: "p", id: "m" });
  const newer = context(); newer.syncRevisions!.members.m.configRevision = 7;
  const sent: unknown[] = [];
  await executeReviewedWrite(started, newer, async revision => { sent.push(revision); }, async () => { throw new Error("legacy"); });
  expect(sent).toEqual([6]);
});

test("missing strict context or a changed login never falls back to legacy", async () => {
  const reviewed = captureWriteReview(context(), { kind: "todo", projectId: "p", id: "t" });
  for (const current of [{ ...context(), capabilities: null }, { ...context(), credentialGeneration: 2 }, { ...context(), projectId: "other" }]) {
    let sent = false;
    await expect(executeReviewedWrite(reviewed, current, async () => { sent = true; }, async () => { sent = true; })).rejects.toThrow();
    expect(sent).toBe(false);
  }
  const missing = context(); missing.syncRevisions = null;
  await expect(executeReviewedWrite(captureWriteReview(missing, { kind: "settings" }), context(), async () => {}, async () => {})).rejects.toThrow();
});

test("legacy writes require an explicit unsupported operations capability", async () => {
  const legacy = context(); legacy.capabilities!.capabilities.operations = false;
  const review = captureWriteReview(legacy, { kind: "settings" });
  expect(await executeReviewedWrite(review, legacy, async () => "strict", async () => "legacy")).toBe("legacy");
  await expect(executeReviewedWrite(review, context(), async () => "strict", async () => "legacy")).rejects.toThrow();
});

test("a batch disarms when a proposal changes while retaining the same ID", () => {
  const reviewed = [{ id: "d", updatedAt: "v1" }, { id: "e", updatedAt: "v2" }];
  expect(sameDecisionReview(reviewed, [{ id: "e", updatedAt: "v2" }, { id: "d", updatedAt: "v1" }])).toBe(true);
  expect(sameDecisionReview(reviewed, [{ id: "d", updatedAt: "v3" }, { id: "e", updatedAt: "v2" }])).toBe(false);
});

test("todo rollback cannot overwrite a newer live row or resurrect an absent row", () => {
  const before = { id: "t", projectId: "p", done: false, title: "original" } as Todo;
  const optimistic = { ...before, done: true };
  expect(rollbackTodo(optimistic, optimistic, before)).toBe(before);
  const newer = { ...optimistic, title: "newer title" };
  expect(rollbackTodo(newer, optimistic, before)).toBeNull();
  expect(rollbackTodo(undefined, optimistic, before)).toBeNull();
});

test("decision confirmation keeps the exact proposal version it armed", async () => {
  const reviewed = captureWriteReview(context(), { kind: "decision", projectId: "p", updatedAt: "2026-11-09T00:00:01.001Z" });
  const sent: unknown[] = [];
  await executeReviewedWrite(reviewed, context(9), async version => { sent.push({ expectedVersion: version }); }, async () => { throw new Error("weaker answer"); });
  expect(sent).toEqual([{ expectedVersion: "2026-11-09T00:00:01.001Z" }]);
});

test("a strict transport failure cannot trigger a legacy write", async () => {
  let strict = 0, legacy = 0;
  const review = captureWriteReview(context(), { kind: "todo", projectId: "p", id: "t" });
  await expect(executeReviewedWrite(review, context(), async () => { strict++; throw Object.assign(new Error("offline"), { status: 0 }); }, async () => { legacy++; })).rejects.toThrow("offline");
  expect([strict, legacy]).toEqual([1, 0]);
});

test("a revision from another project cannot authorize the row on screen", async () => {
  const wrongProject = { ...context(), syncProjectId: "other" };
  const review = captureWriteReview(wrongProject, { kind: "member", projectId: "p", id: "m" });
  let sent = false;
  await expect(executeReviewedWrite(review, context(), async () => { sent = true; }, async () => { sent = true; })).rejects.toThrow();
  expect(sent).toBe(false);
});
