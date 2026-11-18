import type { Delivery } from "../../shared/types.ts";
import type { Store } from "../../server/store.ts";

/** Persist the same receipt as a prior representative-confirmed workflow placement. */
export function reviewedPlacement(store: Store, delivery: Delivery): Delivery {
  const { projectId, memberId, taskId, createdAt } = delivery;
  if (!taskId) throw new Error("A reviewed assignment requires a task");
  const operationId = crypto.randomUUID();
  store.saveWorkflowAssignmentReceipt({ operationId, memberId, revision: "fixture-reviewed-placement" },
    { operationId, memberId, projectId, taskId, createdAt, deliveryId: delivery.id });
  return delivery;
}
