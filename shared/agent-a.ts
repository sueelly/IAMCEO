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
  /** 자료 칸에서 Agent-A 검토 화면(댓글·그림 영역·수정안·판)을 쓸 수 있는가. 화면은 IAMCEO 서버의 검토 길만 부르고, Agent-A 주소·열쇠는 싣지 않는다. */
  ui: boolean;
  uiBlocked: string | null;
  docs: AgentADocSummary[];
  staff: { id: string; name: string }[];
}

/** 자료를 만들 때 함께 넣는 그림(Agent-A 이미지 블록이 된다). */
export interface AgentAImageInput {
  title: string;
  name: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  base64: string;
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

// ---- 검토 화면(IAMCEO 화면 부품) ----
// Agent-A 원래 화면이 쓰는 검토 규약(검토 세션·초안·댓글·수정안·판)을 IAMCEO 서버가 아래 모양으로 옮겨 준다.
// 화면은 Agent-A 를 직접 부르지 않고, Agent-A 가 준 모양을 그대로 받지도 않는다(모르는 칸은 서버가 버린다).

/** 그림의 한 영역. 그림 자신의 픽셀(정수) 기준이다. Agent-A 가 원래 그림 판과 맞춰 본다. */
export interface AgentAReviewImageRegion {
  v: 1;
  src: string;
  sourceLine: number | null;
  naturalWidth: number;
  naturalHeight: number;
  box: { x: number; y: number; w: number; h: number };
}

/** 본문에 든 그림. src 는 Agent-A 안의 경로이고, 화면은 IAMCEO 서버의 그림 길로 받는다. */
export interface AgentAReviewImage {
  src: string;
  width: number;
  height: number;
  sourceLine: number;
}

/** 이 문서의 다른 검토에 남은 초안·제출 기록. 작성 당시의 판에서만 열린다(최신 정본으로 옮기지 않는다). */
export interface AgentAReviewRecovery {
  sessionId: string;
  title: string;
  createdAt: string;
  artifactRevision: number | null;
  stale: boolean;
  submitted: boolean;
  annotations: number;
  attachments: number;
  editedMarkdown: boolean;
}

export interface AgentAReviewDoc {
  fileId: string;
  sessionId: string;
  /** 지금 정본을 보는 검토인지. false 면 과거 판의 검토다(본문은 그때 것). */
  latest: boolean;
  title: string;
  /** 화면에 그릴 본문. 보내지 않은 직접 편집 초안이 있으면 그 초안이다(edited). */
  markdown: string;
  edited: boolean;
  artifactRevision: number | null;
  images: AgentAReviewImage[];
  /** 제출로 닫힌 검토인지. 닫힌 검토에는 새 댓글을 달 수 없다. */
  closed: boolean;
  recoveries: AgentAReviewRecovery[];
}

export interface AgentAReviewAnnotation {
  id: string;
  kind: "comment" | "global" | "deletion";
  text: string;
  /** 고른 원문. 전체 댓글·그림 영역은 빈 글이다. */
  quote: string;
  inReplyTo: string | null;
  /** Agent-A 가 쓴 답인지. */
  ai: boolean;
  author: string | null;
  createdAt: number;
  updatedAt: number | null;
  resolved: boolean;
  region: AgentAReviewImageRegion | null;
  /** 답을 아직 쓰는 중인지(대기·준비). */
  writing: boolean;
  error: { code: string; message: string } | null;
  canRetry: boolean;
  /** '다른 조건으로 질문'으로 갈라진 댓글이면 원래 댓글의 제목. */
  branchOf: string | null;
  /** 앱 수정안처럼 이 화면이 다루지 않는 딸린 내용이 있는지. */
  extra: boolean;
}

export interface AgentAReviewComments {
  version: number;
  annotations: AgentAReviewAnnotation[];
  /** 다른 판의 검토에 남아 있는 댓글 수(검토별). 이 판에는 보이지 않는다. */
  historical: { sessionId: string; count: number }[];
}

export type AgentAProposalStatus = "pending" | "held" | "rejected" | "applied" | "conflict";

export interface AgentAReviewOperation {
  op: string;
  blockId: string;
  title: string;
  before: string | null;
  after: string | null;
}

/** 댓글에 딸린 문서 수정안. */
export interface AgentAReviewProposal {
  annotationId: string;
  proposalId: string;
  status: AgentAProposalStatus;
  reason: string;
  /** 반영됨이고 그 내용이 지금 정본과 같은지. */
  current: boolean;
  operations: AgentAReviewOperation[];
}

/** 검토 판(본문이 달랐던 때마다 하나). */
export interface AgentAReviewVersion {
  version: number;
  at: string;
}

/** 문서 관리: 정본 블록과 그 이전 판, 문서의 모든 수정안, 정본 판 이력. */
export interface AgentAReviewManage {
  artifactRevision: number;
  blocks: AgentABlock[];
  proposals: (Omit<AgentAProposal, "operations"> & { operations: (AgentAProposalOp & { blockTitle: string })[] })[];
  versions: AgentAVersion[];
}

export interface AgentAReviewCommentReq {
  /** 화면이 만든 댓글 id. 같은 id 로 다시 보내도 댓글은 하나다. */
  id: string;
  kind: "comment" | "global";
  text: string;
  quote?: string;
  region?: AgentAReviewImageRegion | null;
}

export interface AgentAReviewWriteResult {
  ok: true;
  id: string;
}
