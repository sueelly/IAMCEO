import type { Delivery } from "../shared/types.ts";

/** Two priority items plus the oldest remaining item keep a coordinator turn
 * small while giving accumulated reports a slot even under new owner input. */
export function selectConductorInputs(deliveries: Delivery[], intervention: (taskId: string) => boolean): Delivery[] {
  const priority = (d: Delivery): number => {
    if (d.urgent && d.wake) return -1;
    if (!d.wake) return 3;
    if (["user_message", "answer", "todo_done"].includes(d.kind)) return 0;
    if (d.taskId && intervention(d.taskId)) return 1;
    return 2;
  };
  const selected = [...deliveries].sort((a, b) => priority(a) - priority(b)).slice(0, 2);
  const oldest = deliveries.find(d => !selected.includes(d));
  return oldest ? [...selected, oldest] : selected;
}
