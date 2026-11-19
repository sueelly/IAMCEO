import type { MessageKind } from "./types.ts";

export interface OwnerCommandMilestone {
  kind: "main" | "application";
  at: string;
  actor: string;
  evidence: string;
  messageId: string | null;
  fileIds: string[];
  commit: string | null;
}

export interface OwnerCommandItem {
  id: string;
  kind: "command" | "task";
  projectId: string;
  taskId: string | null;
  title: string;
  at: string;
  stage: "accepted" | "working" | "result" | "owner" | "waiting";
  detail: string;
  result: { messageId: string; title: string; kind: MessageKind; at: string; fileIds: string[] } | null;
  milestones?: OwnerCommandMilestone[];
  questions: { kind: "decision" | "todo"; id: string; title: string }[];
}

export interface OwnerCommandPage { items: OwnerCommandItem[]; nextCursor: string | null }
