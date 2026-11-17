/** One occurrence of a task on an employee's row. Task registration is not an assignment. */
export const WORKFLOW_OBSERVATION_MAX_AGE_MS = 90_000;
export type WorkflowState = "running" | "starting" | "waiting" | "queued" | "blocked" | "review" | "done" | "unknown";
export interface WorkflowNode {
  id: string;
  taskId: string;
  memberId: string | null;
  order: number;
  state: WorkflowState;
  label: string;
  /** This is the employee's current position, including unfinished work between turns. */
  current: boolean;
  /** Historical deliveries shown as evidence, not retroactively enrolled as prerequisites. */
  historical?: boolean;
  reason: string | null;
  action: { label: string; tab: "team" | "thread" | "inbox"; sub: string | null } | null;
  assignedAt: string;
  observedAt: string | null;
  lastActivity: { kind: string; title: string; at: string } | null;
  counts: { queued: number; held: number; notices: number };
}
export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  kind: "sequence" | "derived";
}
export interface ProjectWorkflow {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowAssignmentRequest { operationId: string; memberId: string; revision: string }
export interface WorkflowAssignmentResult {
  operationId: string; projectId: string; taskId: string; memberId: string; deliveryId: string; createdAt: string;
}
export interface WorkflowAssignmentPreview {
  projectId: string;
  task: { id: string; title: string; branch: string | null; worktree: string | null; parentTaskId: string | null };
  member: { id: string; name: string };
  contract: { taskId: string; rev: number; goal: string; scope: string | null; acceptance: string[]; forbidden: string[]; evidence: string[]; checks: string[]; confirmed: boolean } | null;
  originals: { id: string; taskId: string | null; who: string; at: string; body: string }[];
  reports: { id: string; taskId: string | null; who: string; at: string; kind: string; title: string; body: string }[];
  files: { id: string; taskId: string | null; title: string; summary: string }[];
  attachments: { id: string; name: string }[];
  omitted: { originals: number; reports: number; files: number };
  position: number;
  startCondition: string;
  blockers: string[];
  revision: string;
}
