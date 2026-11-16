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
  /** 블록 요약(제목 아래에 보이는 글). 없으면 빈 글. */
  summary: string;
  body: string;
  archived: boolean;
  /** 근거(출처)를 읽는 글로 옮긴 것. Agent-A 가 가진 그대로이고 이 화면에서는 고치지 않는다. */
  sources: string[];
  /** '검토함'으로 표시한 판. 지금 판과 같으면 검토를 마친 블록이다. 표시한 적이 없으면 null. */
  reviewedRevision: number | null;
  /** 배치 보드에서의 자리와 크기. 정한 적이 없으면 null. */
  layout: AgentABlockLayout | null;
  /** 이 블록의 예전 판(오래된 것부터). 블록 revision 별 본문. */
  history: { revision: number; title: string; summary: string; body: string; archived: boolean }[];
}

/** 배치 보드에서 블록 하나의 자리(x·y)와 크기(width·height). 보드 좌표의 점 단위다. */
export interface AgentABlockLayout {
  x: number;
  y: number;
  width: number;
  height: number;
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
  /** 이 검토가 고정한 정본 본문(직접 고치기 전의 것). 고친 것을 버리면 이 본문으로 돌아간다. */
  canonical: string;
  artifactRevision: number | null;
  images: AgentAReviewImage[];
  /** 제출로 닫힌 검토인지. 닫힌 검토에는 새 댓글을 달 수 없다. */
  closed: boolean;
  /**
   * 이 Agent-A 가 초안 보존 규약(초안 판 비교·댓글 원자 추가)을 아는지.
   * false 면 새 댓글·초안 고치기를 서버가 막는다(다른 화면의 초안을 덮을 수 있어서). 읽기·답글·수정안·판은 그대로다.
   */
  safeWrites: boolean;
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
  /** 댓글에 붙인 그림. */
  images: AgentAReviewAttachment[];
  /** 이 댓글에 고른 AI 설정(고르지 않았으면 null). */
  aiSettings: AgentAReviewAiSettings | null;
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
/** 답을 낼 수 있는 AI 목록(플랫폼·모델·추론 수준). Agent-A 가 지금 연결된 것만 알려 준다. */
export interface AgentAReviewAiCatalog {
  available: boolean;
  defaultProvider: string | null;
  providers: {
    id: string;
    name: string;
    models: { id: string; label: string; default: boolean; efforts: { id: string; label: string }[]; defaultEffort: string | null }[];
  }[];
  error: string | null;
}
/** 검토 초안: 아직 제출하지 않은 직접 편집·주석·첨부. revision 은 초안이 바뀔 때마다 오른다(다른 화면의 저장 포함). */
export interface AgentAReviewDraft {
  revision: number;
  /** 직접 고친 본문. 고친 적이 없으면 null. */
  editedMarkdown: string | null;
  /** 초안에 든 주석(댓글·삭제 표시) 수. */
  annotations: number;
  /** 검토 전체에 붙인 그림. */
  attachments: AgentAReviewAttachment[];
}
export interface AgentAReviewSubmitResult {
  ok: true;
  /** 분기의 질문으로 넘어간 주석·전체 의견 수. */
  sent: number;
  branches: number;
}
/** 문서 대화(Ask AI)의 질문·답 한 쌍. */
export interface AgentAChatEntry {
  id: string;
  prompt: string;
  /** 질문할 때 고른 글. 없으면 null. */
  quote: string | null;
  createdAt: number;
  answer: string;
  /** 답을 쓰는 중인지. */
  writing: boolean;
  error: string | null;
  provider: string | null;
}
/** 문서 대화의 답 흐름 한 줄. */
export type AgentAChatEvent =
  | { type: "start"; conversationId: string }
  | { type: "delta"; text: string }
  | { type: "error"; message: string; code: string }
  | { type: "done"; ok: boolean; text: string };
export interface AgentAChatHistory {
  conversationId: string;
  entries: AgentAChatEntry[];
  /** 다른 대화에서 갈라진 대화면 그 대화 id. */
  branchedFrom: string | null;
}
export interface AgentAChatSession {
  conversationId: string;
  label: string;
  current: boolean;
  /** 지금 답을 쓰는 중인 대화인지. */
  active: boolean;
  createdAt: number;
  updatedAt: number;
}
/** 문서 관리의 분기: 정본 옆에서 이어 가는 질문·답. 답을 채택해도 정본은 바뀌지 않는다. */
export interface AgentAManageBranch {
  id: string;
  title: string;
  status: "open" | "closed";
  parentId: string | null;
  /** 질문 대상(블록 제목·고른 글·그림 영역 등)을 읽는 말로. */
  target: string;
  messages: { id: string; role: "user" | "assistant"; body: string; decision: string | null; reason: string | null; at: string }[];
}
/** 문서 관리의 피드백: 분기의 질문 하나. state 는 not_sent·queued·running·succeeded·failed·unknown. */
export interface AgentAManageFeedback {
  id: string;
  branchId: string;
  branchTitle: string;
  message: string;
  state: string;
}
/** 전송 기록: 고른 질문을 묶어 만든 전송 자료 하나. */
export interface AgentAManageJob {
  id: string;
  state: string;
  error: string | null;
  feedback: number;
}
export interface AgentAReviewManage {
  artifactRevision: number;
  /** 직접 고치기·되살리기 요청에 그대로 되돌려 보낸다(같은 요청을 다시 보내도 같은 명령이 되게). */
  contextRevision: number;
  layoutRevision: number;
  /** 문서의 목표와 제약(Agent-A 의 문맥). 고치면 문맥 판과 정본 판이 오른다. */
  goal: string;
  constraints: string[];
  branches: AgentAManageBranch[];
  feedback: AgentAManageFeedback[];
  jobs: AgentAManageJob[];
  /** 최근 변경 이력(새것부터 30건). */
  events: { seq: number; type: string; at: string }[];
  /** Agent-A 의 자동 연동(CLI 실행)이 켜져 있는지. 꺼져 있으면 전송 자료를 내보내 수동으로 교환한다. */
  adapter: boolean;
  blocks: AgentABlock[];
  proposals: (Omit<AgentAProposal, "operations"> & { operations: (AgentAProposalOp & { blockTitle: string })[] })[];
  versions: AgentAVersion[];
}

/** 답에 쓸 AI·모델·추론 수준. 비운 칸은 Agent-A 기본값을 쓴다. */
export interface AgentAReviewAiSettings {
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
}
/** 댓글에 붙인 그림. path 는 Agent-A 에 먼저 올려서 받은 경로다. */
export interface AgentAReviewAttachment {
  path: string;
  name: string;
}
export interface AgentAReviewCommentReq {
  /** 화면이 만든 댓글 id. 같은 id·같은 내용으로 다시 보내면 처음 결과를 확인한다(댓글은 하나다). */
  id: string;
  /** deletion 은 '이 글을 지우자'는 삭제 표시다(고른 글이 있어야 하고, 댓글 글은 없어도 된다. AI 답은 시작하지 않는다). */
  kind: "comment" | "global" | "deletion";
  text: string;
  quote?: string;
  region?: AgentAReviewImageRegion | null;
  images?: AgentAReviewAttachment[];
  ai?: AgentAReviewAiSettings | null;
}

export interface AgentAReviewWriteResult {
  ok: true;
  id: string;
}
