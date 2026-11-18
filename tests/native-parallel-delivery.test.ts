import { expect, test } from "bun:test";
import { createQueueStatusFixture } from "./fixtures/queue-status-runtime.ts";

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
