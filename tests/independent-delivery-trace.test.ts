import { reviewedPlacement } from "./fixtures/reviewed-placement.ts";
import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";

test("task trace identifies the exact sequence boundary without changing or exposing original inputs", () => {
  const f = fixture();
  const old = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "Earlier scope" }).task;
  const next = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "Independent scope" }).task;
  const prior = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: old.id, kind: "instruction", text: "SECRET_OLD_INPUT" });
  f.store.markDelivered(prior.id);
  const input = f.store.enqueue({ projectId: f.project.id, memberId: f.worker.id, taskId: next.id, kind: "instruction", text: "SECRET_NEW_INPUT" });
  reviewedPlacement(f.store, input);
  const changes = () => f.store.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  const before = changes();
  const result = f.orch.taskTrace(f.worker, next.id);
  expect(result.inputAdmission).toEqual([{ deliveryId: input.id, sequenceBlockerTaskId: old.id,
    sessionGeneration: 0, independentAuthorized: false }]);
  expect(changes()).toBe(before);
  expect(f.store.requireDelivery(input.id)).toEqual(input);
  expect(f.runner.sent).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain("SECRET_");
});
