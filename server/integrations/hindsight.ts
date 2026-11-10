// Hindsight 연결 접점(체험판 내부 계약). 실제 Hindsight 업로드 API·MCP 도구명·인증 형식은 아직 받지 못했다.
// 그래서 여기에는 (1) 서버 업로드 어댑터 인터페이스와 (2) 실행 단위 MCP 검색 바인딩·범위 전달만 둔다.
// 자체 기억 DB·검색 서버·자동 지침 수정은 만들지 않는다. 기본(none)은 외부 호출 0건이다.
import type { HindsightConfig, PublishStatus, SearchContext } from "../../shared/work-types.ts";

export interface UploadRecord {
  recordId: string;
  revision: number;
  kind: "verified_record" | "retrospective" | "improvement_candidate";
  scope: { trialInstanceId: string; projectRef: string; taskRef: string; roleRef?: string };
  content: string;
  /** 원문·결재·자료 참조. 후보와 확정 내용을 구분하는 근거. */
  sourceRefs: string[];
}

export interface PublishResult {
  status: PublishStatus;
  /** 실제(또는 시험 대역) 확인 응답이 있을 때만. */
  remoteReceipt?: string;
  error?: string;
}

export interface HindsightUploadAdapter {
  /** none: 미설정, test: 시험 대역(실제 연결 아님), external: 설정은 있으나 실제 계약 미확인. */
  readonly kind: "none" | "test" | "external";
  publish(record: UploadRecord, idempotencyKey: string): Promise<PublishResult>;
}

export const idempotencyKey = (trialInstanceId: string, recordId: string, revision: number) => `${trialInstanceId}:${recordId}:${revision}`;

/** 미설정: 아무 데도 보내지 않는다. */
export const notConfigured: HindsightUploadAdapter = {
  kind: "none",
  async publish() { return { status: "not_configured" }; },
};

/**
 * 시험 대역. 성공/실패/응답 유실을 흉내 낸다. 같은 키는 한 번만 받은 것으로 친다(대역 서버의 중복 처리).
 * 이 결과는 '시험 성공'일 뿐 실제 업로드 성공이 아니다.
 */
export class TestUploadAdapter implements HindsightUploadAdapter {
  readonly kind = "test" as const;
  /** 대역 서버가 받은 키 → 영수증. 응답 유실이어도 서버는 받았을 수 있다. */
  readonly received = new Map<string, string>();
  calls = 0;
  constructor(public mode: "success" | "fail" | "lost") {}
  async publish(_record: UploadRecord, key: string): Promise<PublishResult> {
    this.calls++;
    if (this.mode === "fail") return { status: "failed", error: "시험 대역이 실패를 돌려줬습니다" };
    const receipt = this.received.get(key) ?? `test-receipt-${this.received.size + 1}`;
    this.received.set(key, receipt);
    if (this.mode === "lost") return { status: "unknown", error: "시험 대역: 응답을 받지 못했습니다(서버는 받았을 수 있음)" };
    return { status: "uploaded", remoteReceipt: receipt };
  }
}

/**
 * 설정(주소·인증 참조)은 있지만 실제 업로드 계약을 아직 받지 않은 상태. 추측한 HTTP 호출을 하지 않는다.
 * 계약을 받으면 이 자리에 실제 변환·호출을 넣는다.
 */
export const externalPending: HindsightUploadAdapter = {
  kind: "external",
  async publish() { return { status: "not_configured", error: "실제 업로드 계약(주소·형식·인증·확인 응답)을 아직 받지 못해 보내지 않았습니다" }; },
};

export function createUploadAdapter(config: HindsightConfig, testAdapters: Map<string, TestUploadAdapter>): HindsightUploadAdapter {
  const mode = config.upload.mode;
  if (mode === "none") return notConfigured;
  if (mode === "external") return externalPending;
  const key = mode.replace("test_", "") as "success" | "fail" | "lost";
  // 대역은 모드가 바뀌어도 받은 키를 기억해야 중복 업로드를 검사할 수 있다.
  const shared = testAdapters.get("test") ?? new TestUploadAdapter(key);
  shared.mode = key;
  testAdapters.set("test", shared);
  return shared;
}

export interface SearchBinding { mcpServerRef: string | null; toolRef: string | null; authRef: string | null; scopeMapping: Record<string, string> }

/**
 * 실행 단위 검색 문맥. 실제 MCP 인자는 확인된 계약으로만 매핑한다. 여기서는 어떤 바인딩을 어떤 범위로
 * 넘길지까지만 만든다. 바인딩이 있어도 실제 호출을 확인하기 전에는 'configured_unverified'다.
 */
export function buildSearchContext(input: { trialInstanceId: string; projectId: string; taskId: string; roleId: string; sourceRefs: string[] }, binding: SearchBinding): SearchContext {
  const configured = !!(binding.mcpServerRef && binding.toolRef);
  return {
    bindingRef: configured ? `${binding.mcpServerRef}#${binding.toolRef}` : null,
    status: configured ? "configured_unverified" : "not_configured",
    scope: { trialInstanceId: input.trialInstanceId, projectRef: input.projectId, taskRef: input.taskId, roleRef: input.roleId },
    sourceRefs: input.sourceRefs,
  };
}

export function uploadStateLabel(config: HindsightConfig): string {
  switch (config.upload.mode) {
    case "none": return "연결 전(미설정) · 외부 호출 없음";
    case "external": return "설정됨 · 실제 계약 미확인이라 보내지 않음";
    default: return "시험 대역 연결 · 실제 업로드 아님";
  }
}
export function searchStateLabel(config: HindsightConfig): string {
  return config.search.mcpServerRef && config.search.toolRef ? "설정됨 · 실제 검색 미확인" : "연결 전(미설정)";
}

export const DEFAULT_HINDSIGHT: HindsightConfig = {
  upload: { mode: "none", endpointRef: null, authRef: null },
  search: { mcpServerRef: null, toolRef: null, authRef: null, scopeMapping: { project: "projectRef", task: "taskRef", role: "roleRef" } },
};
