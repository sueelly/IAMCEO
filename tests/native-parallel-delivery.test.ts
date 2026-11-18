import { expect, test } from "bun:test";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

test("a conductor's assignment cannot overwrite either owner preference, even with a cached parallel field", async () => {
  const f = fixture();
  const contract = { kind: "other", goal: "원고 확인", scope: "이 장면", inputs: ["원고"], outputs: ["결과"],
    constraints: [], exclusions: [], acceptance: ["장면을 확인한다"] };
  for (const ownerPreference of [true, false]) {
    const worker = ownerPreference ? f.worker : f.worker2;
    f.store.patchMember(worker.id, { parallel: ownerPreference });
    const task = f.orch.saveTask(f.lead, { title: worker.name + " 원고 확인" }).task;
    const result = await f.tool(f.lead, "team_assign", { member: worker.handle, text: "원고 확인", task_id: task.id,
      contract, parallel: !ownerPreference });
    expect(result.isError, result.text).toBeUndefined();
    expect(f.store.requireMember(worker.id).parallel).toBe(ownerPreference);
    expect(f.store.listTaskDeliveries(task.id).filter(d => d.kind === "instruction")).toHaveLength(1);
  }
});

test("a managed Claude worker confirms the default session switch before delivering the original instruction", async () => {
  const f = await createQueueStatusFixture();
  try {
    const delivery = f.store.enqueue({ projectId: f.project.id, memberId: f.member.id,
      kind: "instruction", text: "Check two independent drafts", wake: true });
    await f.orch.pump(f.member.id);
    expect(f.store.parallelApplied(f.member.id)).toBe(true);
    expect(f.controls).toEqual([{ terminal: f.member.paneId!, text: "/effort ultracode on" }]);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.text).toStartWith("Check two independent drafts\n");
    expect(f.store.requireDelivery(delivery.id)).toMatchObject({ status: "delivered", attempts: 1 });
  } finally { await f.stop(); }
});
