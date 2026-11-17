import { expect, test } from "bun:test";
import { Store } from "../server/store.ts";
import { Bus } from "../server/bus.ts";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("a failed CLI exit cannot relaunch on queued input, repeated polling or Store reconstruction", async () => {
  const f = await createQueueStatusFixture();
  try {
    await until(() => !!f.store.requireMember(f.member.id).paneId);
    const terminal = f.terminals.get(f.store.requireMember(f.member.id).paneId!)!;
    terminal.state = "finished"; terminal.reason = "exited"; terminal.exit_code = 1;
    await until(() => f.store.requireMember(f.member.id).status === "offline" || f.store.requireMember(f.member.id).status === "error");
    const queued = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Keep this input", wake: true });
    for (let i = 0; i < 6; i++) await f.orch.pump(f.member.id);
    expect(f.terminals.size).toBe(1);
    expect(f.writes).toHaveLength(0);
    expect(f.store.requireDelivery(queued.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.store.requireMember(f.member.id).executionIssue).toMatchObject({ kind: "startup_failed", exitCode: 1, terminalId: terminal.address });
    const restored = new Store(f.store.db, new Bus());
    expect(restored.requireMember(f.member.id).executionIssue?.kind).toBe("startup_failed");
    expect(f.store.listActivity(f.member.id).filter(a => a.kind === "error" && a.text.includes("exit_code=1"))).toHaveLength(1);
    await f.orch.resumeMember(f.member.id);
    await until(() => f.store.requireDelivery(queued.id).status === "delivered");
    expect(f.writes).toHaveLength(1);
    expect(f.store.requireMember(f.member.id).executionIssue).toBeNull();
  } finally { await f.stop(); }
});

test.each([
  ["You've hit your weekly limit · resets 7am (Asia/Seoul)", "usage_limit"],
  ["Rate limit exceeded. Please try again later", "usage_limit"],
  ["Unauthorized: please log in again", "authentication"],
] as const)("provider failure is distinguished and cannot automatically consume the next input: %s", async (message, kind) => {
  const f = await createQueueStatusFixture();
  try {
    await until(() => !!f.store.requireMember(f.member.id).paneId);
    await f.orch.sendUserMessage(f.project.id, { targetMemberId: f.member.id, text: "First request" });
    const terminal = f.terminals.get(f.store.requireMember(f.member.id).paneId!)!;
    terminal.turn = (terminal.turn ?? 0) + 1;
    terminal.status = { state: "error", app: "claude-code", msg: message };
    await until(() => f.store.requireMember(f.member.id).status === "error");
    const next = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Next request", wake: true });
    for (let i = 0; i < 4; i++) await f.orch.pump(f.member.id);
    expect(f.store.requireMember(f.member.id).executionIssue?.kind).toBe(kind);
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.writes).toHaveLength(1);
    // A real successful terminal observation clears the old provider error.
    terminal.turn = (terminal.turn ?? 0) + 1; terminal.status = { state: "done", app: "claude-code" };
    await until(() => f.store.requireDelivery(next.id).status === "delivered");
    expect(f.store.requireMember(f.member.id).executionIssue).toBeNull();
  } finally { await f.stop(); }
});

test("capacity waits report the actual global count and clear when a slot is available", async () => {
  const f = await createQueueStatusFixture(1);
  try {
    await until(() => !!f.store.requireMember(f.member.id).paneId);
    await f.orch.sendUserMessage(f.project.id, { targetMemberId: f.member.id, text: "Occupy the slot" });
    const second = await f.orch.createMember(f.project.id, { name: "Queued worker", cli: "claude" });
    await until(() => !!f.store.requireMember(second.id).paneId);
    const delivery = f.store.enqueue({ projectId: f.project.id, memberId: second.id, kind: "instruction", text: "Wait for capacity", wake: true });
    await f.orch.pump(second.id);
    expect(f.store.requireMember(second.id).deliveryWait).toMatchObject({ kind: "capacity", active: 1, limit: 1 });
    expect(f.store.requireDelivery(delivery.id).attempts).toBe(0);
    f.done();
    await until(() => f.store.requireDelivery(delivery.id).status === "delivered");
    expect(f.store.requireMember(second.id).deliveryWait).toBeNull();
  } finally { await f.stop(); }
});

test("manual terminal control and current execution are different queue waits", async () => {
  const f = await createQueueStatusFixture();
  try {
    await until(() => !!f.store.requireMember(f.member.id).paneId);
    const member = f.store.requireMember(f.member.id);
    await f.orch.terminalControl(member.id, { action: "claim" });
    f.store.saveLease(f.runner.terminalLease(member.id)!);
    f.store.enqueue({ projectId: f.project.id, memberId: member.id, kind: "instruction", text: "Wait for manual control", wake: true });
    await f.orch.pump(member.id);
    expect(f.store.requireMember(member.id).deliveryWait?.kind).toBe("manual_control");
  } finally { await f.stop(); }
});

test("explicit quota recheck preserves the provider error and untouched input while the CLI still reports error", async () => {
  const f = await createQueueStatusFixture();
  try {
    await f.orch.sendUserMessage(f.project.id, { targetMemberId: f.member.id, text: "First request" });
    const terminal = f.terminals.get(f.store.requireMember(f.member.id).paneId!)!;
    terminal.turn = (terminal.turn ?? 0) + 1;
    terminal.status = { state: "error", app: "claude-code", msg: "You've hit your weekly limit" };
    await until(() => !!f.store.requireMember(f.member.id).executionIssue);
    const next = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Keep next input", wake: true });
    await expect(f.orch.resumeMember(f.member.id)).rejects.toThrow("해소");
    expect(f.store.requireMember(f.member.id)).toMatchObject({ executionIssue: { kind: "usage_limit" }, lastError: "You've hit your weekly limit" });
    expect(f.store.requireDelivery(next.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(f.writes).toHaveLength(1);
  } finally { await f.stop(); }
});

test("a generic provider error followed by nonzero process exit cannot bypass the exit barrier", async () => {
  const f = await createQueueStatusFixture();
  try {
    await f.orch.sendUserMessage(f.project.id, { targetMemberId: f.member.id, text: "First request" });
    const terminal = f.terminals.get(f.store.requireMember(f.member.id).paneId!)!;
    terminal.turn = (terminal.turn ?? 0) + 1;
    terminal.status = { state: "error", app: "claude-code", msg: "Unexpected internal processing failure" };
    await until(() => f.store.requireMember(f.member.id).status === "error");
    terminal.state = "finished"; terminal.reason = "exited"; terminal.exit_code = 1;
    const next = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Keep next input", wake: true });
    for (let i = 0; i < 4; i++) await f.orch.pump(f.member.id);
    await until(() => !!f.store.requireMember(f.member.id).executionIssue);
    expect(f.terminals.size).toBe(1);
    expect(f.writes).toHaveLength(1);
    expect(f.store.requireMember(f.member.id).executionIssue).toMatchObject({ kind: "startup_failed", exitCode: 1 });
    expect(f.store.requireDelivery(next.id).status).not.toBe("delivered");
  } finally { await f.stop(); }
});

test("async draft refusal immediately explains the input wait without changing the draft", async () => {
  const f = await createQueueStatusFixture();
  try {
    f.setScreen("result\n" + "─".repeat(50) + "\n❯ keep my unfinished draft\n" + "─".repeat(50));
    f.store.enqueue({ projectId: f.project.id, memberId: f.member.id, kind: "instruction", text: "Wait for empty composer", wake: true });
    await f.orch.pump(f.member.id);
    expect(f.store.requireMember(f.member.id).deliveryWait?.kind).toBe("input");
    expect(f.writes).toHaveLength(0);
    expect(f.keys).toHaveLength(0);
  } finally { await f.stop(); }
});

test("a project cap explains its own wait while the preserved global limit stays twenty", async () => {
  const f = await createQueueStatusFixture(20);
  try {
    f.store.patchProject(f.project.id, { maxConcurrentTurns: 1 });
    await f.orch.sendUserMessage(f.project.id, { targetMemberId: f.member.id, text: "Occupy one project slot" });
    const second = await f.orch.createMember(f.project.id, { name: "Project waiter", cli: "claude" });
    const input = f.store.enqueue({ projectId: f.project.id, memberId: second.id, kind: "instruction", text: "Wait for this project", wake: true });
    await f.orch.pump(second.id);
    expect(f.store.requireMember(second.id).deliveryWait).toMatchObject({ kind: "project_capacity", active: 1, limit: 1 });
    expect(f.store.getSettings().maxConcurrentTurns).toBe(20);
    expect(f.store.requireDelivery(input.id)).toMatchObject({ status: "queued", attempts: 0 });
    f.done();
    await until(() => f.store.requireDelivery(input.id).status === "delivered");
    expect(f.store.requireMember(second.id).deliveryWait).toBeNull();
    expect(f.store.getSettings().maxConcurrentTurns).toBe(20);
  } finally { await f.stop(); }
});
