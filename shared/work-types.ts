// 업무 중심 로컬 체험판의 공유 타입. 운영 IAMCEO 모델(Project/Member/Message)과 섞지 않는다.
// 업무(Task)가 대화·결재·자료·실행의 주인이고, 역할(Role)은 재사용 정의, 실행(Run)은 업무별 문맥이다.

export type TaskStatus = "received" | "working" | "waiting_owner" | "waiting_dep" | "done";
export type RunStatus = "active" | "retired";
export type RunReason = "start" | "role_change" | "model_change" | "resume";
export type InputSource = "owner" | "handoff" | "answer" | "dependency" | "collab_question" | "collab_answer";

export interface WorkProject { id: string; name: string; kind: "project" | "hq"; note: string }
export interface WorkGoal { id: string; title: string; note: string }
export interface WorkRole { id: string; name: string; description: string; defaultModel: string }

export interface WorkTask {
  id: string;
  projectId: string;
  goalId: string | null;
  title: string;
  criteria: string;
  status: TaskStatus;
  roleId: string;
  model: string;
  dependsOn: string | null;
  activeRunId: string | null;
  template: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchContext {
  bindingRef: string | null;
  status: "not_configured" | "configured_unverified";
  scope: { trialInstanceId: string; projectRef: string; taskRef: string; roleRef: string };
  sourceRefs: string[];
}

export interface RunInput {
  id: string;
  runId: string;
  seq: number;
  source: InputSource;
  text: string;
  searchContext: SearchContext | null;
  state: "pending" | "done";
  at: string;
}

export interface WorkRun {
  id: string;
  taskId: string;
  roleId: string;
  model: string;
  status: RunStatus;
  reason: RunReason;
  handoff: string | null;
  runner: "trial";
  startedAt: string;
  endedAt: string | null;
}

export type MessageKind = "instruction" | "reply" | "result" | "handoff" | "status" | "late" | "collab_q" | "collab_a";
export interface WorkMessage {
  id: string;
  taskId: string;
  runId: string | null;
  author: "owner" | "agent" | "system";
  kind: MessageKind;
  body: string;
  peerTaskId: string | null;
  clientId: string | null;
  at: string;
}

export interface DecisionOption { k: string; label: string; desc?: string }
export interface WorkDecision {
  id: string;
  taskId: string;
  runId: string;
  title: string;
  detail: string;
  options: DecisionOption[];
  status: "open" | "answered";
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
}

export interface WorkFile { id: string; taskId: string; runId: string; title: string; content: string; at: string }

export type PublishStatus = "not_configured" | "uploaded" | "failed" | "unknown";
export interface HindsightRecordView {
  id: string;
  taskId: string;
  recordId: string;
  revision: number;
  kind: "verified_record" | "retrospective" | "improvement_candidate";
  idempotencyKey: string;
  status: PublishStatus;
  adapter: "none" | "test" | "external";
  receipt: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type UploadMode = "none" | "test_success" | "test_fail" | "test_lost" | "external";
export interface HindsightConfig {
  upload: { mode: UploadMode; endpointRef: string | null; authRef: string | null };
  search: { mcpServerRef: string | null; toolRef: string | null; authRef: string | null; scopeMapping: Record<string, string> };
}

export interface CoordinationNote { kind: "order" | "waiting" | "parallel_role" | "owner"; text: string; taskIds: string[] }

export interface WorkState {
  trial: { instanceId: string; label: string; runner: "trial"; externalModelCalls: number; startedAt: string };
  projects: WorkProject[];
  goals: WorkGoal[];
  roles: WorkRole[];
  models: string[];
  tasks: WorkTask[];
  decisions: WorkDecision[];
  files: Pick<WorkFile, "id" | "taskId" | "runId" | "title" | "at">[];
  coordination: CoordinationNote[];
  hindsight: { config: HindsightConfig; records: HindsightRecordView[]; uploadState: string; searchState: string };
  version: number;
}

export interface TaskDetail {
  task: WorkTask;
  messages: WorkMessage[];
  runs: (WorkRun & { inputs: RunInput[] })[];
  decisions: WorkDecision[];
  files: WorkFile[];
  records: HindsightRecordView[];
}
