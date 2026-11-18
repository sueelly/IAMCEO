import { reviewedPlacement } from "./fixtures/reviewed-placement.ts";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { startServer } from "../server/http.ts";
import type { OrchestratorApi } from "../server/orchestrator-api.ts";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture(options: { readOnly?: boolean; unsupported?: boolean } = {}) {
  const f = await createQueueStatusFixture();
  cleanups.push(f.stop);
  const previous = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "http-independent:previous",
    title: "Previous work awaiting owner review", origin: "owner" }).task;
  const original = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: previous.id,
    kind: "instruction", text: "Previous original; preserve without replay", wake: true });
  f.store.markDelivered(original.id);
  f.store.addStageMark({ projectId: f.project.id, taskId: previous.id, stage: "review",
    evidence: "Owner review remains open", memberId: null, who: "Fixture" });
  const decision = f.store.createDecision({ projectId: f.project.id, memberId: f.member.id, taskId: previous.id,
    who: f.member.name, title: "May the previous work continue?", options: [{ k: "wait", label: "Keep waiting" }] });
  const nextTask = f.store.ensureSourceTask({ projectId: f.project.id, sourceRef: "http-independent:next",
    title: "Independent approved work", origin: "owner" }).task;
  for (const task of [previous, nextTask]) f.store.saveTaskContract(task.id, {
    kind: "other", goal: "독립된 업무 결과를 검증한다", inputs: ["확정된 지시"], outputs: ["검증 결과"],
    scope: "해당 업무만 수행", constraints: [], exclusions: [], acceptance: ["결과를 확인한다"], checks: [],
  }, { author: "Fixture", authorMemberId: null, authorKind: "owner" });
  const selected = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: nextTask.id,
    kind: "instruction", text: "Selected existing original instruction", wake: true });
  reviewedPlacement(f.store, selected);
  const unselected = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, taskId: nextTask.id,
    kind: "instruction", text: "Unselected original on the same independent task", wake: true });
  await f.orch.pump(f.member.id);
  expect(f.store.requireDelivery(selected.id)).toMatchObject({ status: "queued", attempts: 0 });
  const source = f.store.createMessage({ projectId: f.project.id, taskId: previous.id, targetMemberId: f.member.id,
    mine: true, who: "대표", kind: "나", body: "앞선 업무와 결재는 보존하고 선택한 독립 업무의 기존 지시만 먼저 받으세요." });
  const request = () => ({ operationId: randomUUID(), sourceMessageId: source.id,
    expectedSessionGeneration: f.store.memberRevisions(f.member.id).sessionGeneration,
    expectedBlockerTaskId: previous.id });
  const before = { original: f.store.requireDelivery(original.id), decision: f.store.getDecision(decision.id),
    marks: f.store.listStageMarks(previous.id), selected: f.store.requireDelivery(selected.id),
    unselected: f.store.requireDelivery(unselected.id), deliveries: f.store.listDeliveries() };
  const unchanged = () => {
    expect(f.store.requireDelivery(original.id)).toEqual(before.original);
    expect(f.store.getDecision(decision.id)).toEqual(before.decision);
    expect(f.store.listStageMarks(previous.id)).toEqual(before.marks);
    expect(f.store.doneMark(previous.id)).toBeNull();
  };
  const rejectedUnchanged = () => {
    unchanged();
    expect(f.store.requireDelivery(selected.id)).toEqual(before.selected);
    expect(f.store.requireDelivery(unselected.id)).toEqual(before.unselected);
    expect(f.store.listDeliveries()).toEqual(before.deliveries);
    expect(f.store.listDeliveryDispatches(selected.id)).toHaveLength(0);
    expect(f.writes).toHaveLength(0);
    expect(f.keys).toHaveLength(0);
  };
  const orch: OrchestratorApi = options.unsupported ? Object.create(f.orch) : f.orch;
  if (options.unsupported) Object.defineProperty(orch, "authorizeIndependentDelivery", { value: undefined });
  const server = await startServer({ config: f.config, store: f.store, bus: f.bus, orch,
    readOnly: options.readOnly, detectHosts: () => ["127.0.0.1"] });
  cleanups.push(() => server.stop());
  expect(server.port).not.toBe(7878);
  const base = `http://127.0.0.1:${server.port}`;
  f.orch.setServerUrl(base);
  const auth = { Authorization: `Bearer ${f.config.accessCode}` };
  const path = (projectId = f.project.id, deliveryId = selected.id) =>
    `/api/projects/${projectId}/deliveries/${deliveryId}/independent`;
  const post = (body: unknown, headers: Record<string, string> = auth, projectId = f.project.id,
    deliveryId = selected.id) => fetch(base + path(projectId, deliveryId), {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  return { ...f, base, auth, path, post, request, previous, original, decision, source,
    nextTask, selected, unselected, before, unchanged, rejectedUnchanged };
}

test("independent delivery requires owner Bearer authentication and refuses employee tokens", async () => {
  const f = await fixture();
  const credentials: Record<string, string>[] = [{}, { Authorization: "Bearer wrong" },
    { Authorization: `Bearer ${f.store.getMemberToken(f.member.id)}` }];
  for (const headers of credentials) {
    const response = await f.post(f.request(), headers);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  f.rejectedUnchanged();
});

test("owner HTTP authorization delivers only the selected existing original and preserves its receipt across replay", async () => {
  const f = await fixture(), body = f.request();
  const response = await f.post(body);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ operationId: body.operationId, projectId: f.project.id, deliveryId: f.selected.id });
  await f.orch.pump(f.member.id);
  expect(f.store.requireDelivery(f.selected.id)).toMatchObject({ id: f.selected.id, status: "delivered", attempts: 1,
    text: "Selected existing original instruction" });
  expect(f.store.requireDelivery(f.unselected.id)).toEqual(f.before.unselected);
  expect(f.store.listDeliveries().map(delivery => delivery.id)).toEqual(f.before.deliveries.map(delivery => delivery.id));
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]!.text.startsWith("Selected existing original instruction\n")).toBe(true);
  expect(f.writes[0]!.text).not.toContain("Unselected original");
  expect(f.writes[0]!.text).not.toContain("Previous original");
  expect(f.store.listDeliveryDispatches(f.selected.id)).toHaveLength(1);
  expect(f.store.listDeliveryDispatches(f.selected.id)[0]!.transportState).toBe("accepted");
  const replay = await f.post(body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
  const receipt = await fetch(`${f.base}/api/projects/${f.project.id}/workflow/assignments/${body.operationId}`, { headers: f.auth });
  expect(receipt.status).toBe(200);
  expect(await receipt.json()).toEqual(result);
  expect(f.writes).toHaveLength(1);
  expect(f.store.listDeliveryDispatches(f.selected.id)).toHaveLength(1);
  expect(f.keys).toHaveLength(0);
  f.unchanged();
});

test("independent delivery rejects an unknown body field before changing the original queue", async () => {
  const f = await fixture(), valid = f.request();
  for (const body of [{ ...valid, urgent: true }, { ...valid, operationId: "not-a-uuid" },
    { ...valid, expectedSessionGeneration: -1 }, { ...valid, expectedSessionGeneration: 0.5 }]) {
    expect((await f.post(body)).status).toBe(400);
  }
  const invalidJson = await fetch(f.base + f.path(), { method: "POST", headers: f.auth, body: "{" });
  expect(invalidJson.status).toBe(400);
  f.rejectedUnchanged();
});

test("independent delivery rejects foreign project and source scopes and stale session conditions", async () => {
  const f = await fixture(), body = f.request();
  const other = f.store.createProject({ name: "Foreign HTTP scope", cwd: f.dir });
  const foreignSource = f.store.createMessage({ projectId: other.id, mine: true, who: "대표", kind: "나",
    body: "This instruction belongs to a different project" });
  expect([404, 409]).toContain((await f.post(body, f.auth, other.id)).status);
  expect((await f.post(body, f.auth, f.project.id, "missing-delivery")).status).toBe(404);
  expect([404, 409]).toContain((await f.post({ ...body, operationId: randomUUID(), sourceMessageId: foreignSource.id })).status);
  expect((await f.post({ ...body, operationId: randomUUID(), expectedSessionGeneration: body.expectedSessionGeneration + 1 })).status).toBe(409);
  expect((await f.post({ ...body, operationId: randomUUID(), expectedBlockerTaskId: f.nextTask.id })).status).toBe(409);
  f.rejectedUnchanged();
});

test("a read-only server refuses independent authorization before any receipt or input is created", async () => {
  const f = await fixture({ readOnly: true }), body = f.request();
  const response = await f.post(body);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "READ_ONLY" });
  expect(f.store.workflowAssignmentReceipt(body.operationId)).toBeNull();
  f.rejectedUnchanged();
});

test("independent delivery cannot reuse an operation ID already reserved for terminal control", async () => {
  const f = await fixture(), body = f.request();
  const pending = f.store.beginOperation({ operationId: body.operationId, kind: "terminal_control",
    projectId: f.project.id, memberId: f.member.id, request: { action: "claim" } });
  expect((await f.post(body)).status).toBe(409);
  expect(f.store.getOperation(body.operationId)).toEqual(pending);
  expect(f.store.workflowAssignmentReceipt(body.operationId)).toBeNull();
  f.rejectedUnchanged();
});

test("an owner server without the optional independent-delivery port returns unsupported", async () => {
  const f = await fixture({ unsupported: true });
  expect((await f.post(f.request())).status).toBe(501);
  f.rejectedUnchanged();
});
