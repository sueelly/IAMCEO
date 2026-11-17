import type { Store } from "./store.ts";

/** Logical queue admission shared by dispatch and continuation priority.
 * Physical writes, ownership, approvals and task ordering have additional gates.
 */
export function ordinaryInputAdmitted(store: Store, deliveryId: string): boolean {
  const recovery = store.getDeliveryRecovery(deliveryId);
  if (recovery?.phase === "stopped" || store.getDeliveryRetry(deliveryId).retryReason === "rejected_limit") return false;
  // A resolved receipt is history; only proven refusal before writing can retry.
  return recovery?.phase !== "resolved" || recovery.reason === "not_received" && store.listDeliveryDispatches(deliveryId).at(-1)?.transportState === "rejected";
}
