// Agent-A 연결(체험판). 정본·검토·제안은 Agent-A 서버가, 업무·담당·전달은 IAMCEO 서버가 맡는다.
// 화면은 이 모양만 받는다. Agent-A 주소·열쇠는 서버 설정에만 있고 여기에 싣지 않는다.

/** 요청 하나를 실제로 실행하는 곳. 요청을 만들 때 하나로 고정하고 바꾸지 않는다. */
export type AgentAExecutor = "agent_a" | "staff";

/**
 * sending: Agent-A 에 질문을 쓰는 중 · unconfirmed: 쓰기 응답을 못 받아 같은 명령으로 다시 확인 중
 * queued: Agent-A 에 접수(아직 실행 전) · running: Agent-A 자체 AI 가 답을 쓰는 중
 * waiting_staff: IAMCEO 직원에게 맡김(직원 답을 기다림) · answered: 답 저장됨
 * failed: 실행 실패 · unknown: 실행 결과를 확인하지 못함(자동 재실행 안 함) · stop_requested: 멈춤 요청함(확인 전)
 */
export type AgentARequestState =
  | "sending"
  | "unconfirmed"
  | "queued"
  | "running"
  | "waiting_staff"
  | "answered"
  | "failed"
  | "unknown"
  | "stop_requested";

export interface AgentABlock {
  id: string;
  revision: number;
  kind: string;
  title: string;
  body: string;
  archived: boolean;
  /** 이 블록의 예전 판(오래된 것부터). 블록 revision 별 본문. */
  history: { revision: number; title: string; body: string; archived: boolean }[];
}

export interface AgentAMessage {
  id: string;
  role: "user" | "assistant";
  body: string;
  questionId: string | null;
  createdAt: string;
}

export interface AgentAProposalOp {
  op: string;
  blockId: string;
  baseRevision: number;
  title: string | null;
  /** 바꾸기 전 본문(제안이 기준으로 삼은 블록 판). 없으면 null. */
  before: string | null;
  /** 바꾼 뒤 본문. 보관(archive)은 null. */
  after: string | null;
}

export interface AgentAProposal {
  id: string;
  status: "pending" | "held" | "rejected" | "applied" | "conflict";
  reason: string;
  baseArtifactRevision: number;
  operations: AgentAProposalOp[];
  /** 지금 정본에 그대로 반영할 수 있는가(블록 판·문맥 판이 그대로인가). */
  applicable: boolean;
  /** 반영할 수 없을 때의 까닭(일상어). */
  staleReason: string | null;
}

export interface AgentALateResult {
  memberId: string;
  memberName: string;
  assignmentGen: number;
  answer: string;
  at: string;
}

export interface AgentARequest {
  id: string;
  fileId: string;
  parentId: string | null;
  /** 최신본 기준으로 다시 낸 요청이면 원래 요청 id. */
  supersedesId: string | null;
  branchId: string;
  questionId: string | null;
  blockId: string;
  blockRevision: number;
  baseArtifactRevision: number;
  quote: string | null;
  text: string;
  taskId: string | null;
  executor: AgentAExecutor;
  assigneeId: string | null;
  assigneeName: string | null;
  assignmentGen: number;
  state: AgentARequestState;
  error: string | null;
  answer: AgentAMessage | null;
  proposals: AgentAProposal[];
  lateResults: AgentALateResult[];
  seen: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAVersion {
  revision: number;
  at: string;
  /** 무엇이 이 판을 만들었나(일상어). */
  cause: string;
}

export interface AgentADocView {
  fileId: string;
  projectId: string;
  artifactId: string;
  title: string;
  taskId: string | null;
  executor: AgentAExecutor;
  assigneeId: string | null;
  artifactRevision: number;
  contextRevision: number;
  blocks: AgentABlock[];
  requests: AgentARequest[];
  versions: AgentAVersion[];
  /** 이 화면의 Agent-A 가 실제 서버인지(체험 대체가 아닌지). */
  source: "agent_a_server";
  readAt: string;
}

export interface AgentADocSummary {
  fileId: string;
  artifactId: string;
  pending: number;
  unseen: number;
  /** 가장 최근에 끝났는데 아직 안 본 요청(알림에서 원래 댓글로 갈 때). */
  latestUnseen: string | null;
}

export interface AgentAProjectInfo {
  enabled: boolean;
  /** Agent-A 서버에 닿는가. 닿지 않으면 까닭. */
  reachable: boolean;
  error: string | null;
  docs: AgentADocSummary[];
  staff: { id: string; name: string }[];
}

export interface AgentACreateRequestReq {
  opId: string;
  blockId: string;
  blockRevision: number;
  quote?: string | null;
  text: string;
  /** 최신본 기준으로 다시 낼 때 원래 요청 id. */
  supersedesId?: string | null;
}

export interface AgentAReplyReq {
  opId: string;
  text: string;
}

export interface AgentADecideReq {
  opId: string;
  reason?: string;
}

export interface AgentAOpResult {
  opId: string;
  state: "committed" | "conflict" | "unknown" | "failed";
  message: string | null;
  artifactRevision: number | null;
  /** 반영 뒤 정본을 다시 읽어 바뀐 본문이 실제로 들어 있는지 확인했는가. */
  verified: boolean;
}
