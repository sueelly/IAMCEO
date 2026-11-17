import type { DeliveryWait, ExecutionIssue, Member } from "./types.ts";

export function providerIssueKind(text: string | null | undefined): "usage_limit" | "authentication" | null {
  if (!text) return null;
  if (/unauthori[sz]ed|authentication|invalid (?:api.?key|access.?token)|(?:please|must|need to) (?:log|sign) in|인증.*(?:실패|필요)|로그인.*필요/i.test(text)) return "authentication";
  if (/quota|(?:weekly|daily|monthly|usage|rate|spending)[ _-]?limit|too many requests|insufficient (?:credits|balance)|(?:사용량|주간|일일|요청).*한도/i.test(text)) return "usage_limit";
  return null;
}

export function issueLabel(issue: Pick<ExecutionIssue, "kind">): string {
  return { usage_limit: "사용량 한도", authentication: "로그인 필요", startup_failed: "실행 종료 오류", session_missing: "대화 복구 필요" }[issue.kind];
}

/** Older servers still expose quota/authentication through lastError. */
export function memberIssueLabel(member: Pick<Member, "executionIssue" | "lastError">): string | null {
  const kind = member.executionIssue?.kind ?? providerIssueKind(member.lastError);
  return kind ? issueLabel({ kind }) : null;
}

export function deliveryWaitText(wait: DeliveryWait): { label: string; reason: string } {
  switch (wait.kind) {
    case "capacity": return { label: "실행 자리 대기", reason: `전체 실행 ${wait.active ?? "?"}/${wait.limit ?? "?"}개가 사용 중입니다. 자리가 비면 전달합니다` };
    case "project_capacity": return { label: "프로젝트 실행 자리 대기", reason: `이 프로젝트의 실행 ${wait.active ?? "?"}/${wait.limit ?? "?"}개가 사용 중입니다. 자리가 비면 전달합니다` };
    case "working": return { label: "현재 실행 대기", reason: "직원의 현재 실행이 끝나면 다음 입력을 전달합니다" };
    case "manual_control": return { label: "직접 조작 중", reason: "터미널 직접 조작이 끝나면 입력을 전달합니다" };
    case "permission": return { label: "승인 응답 대기", reason: "직원의 승인 창에서 응답을 기다립니다" };
    case "selection": return { label: "선택 응답 대기", reason: "직원의 선택 창에서 응답을 기다립니다" };
    case "setup": return { label: "초기 설정 대기", reason: "직원의 초기 설정·폴더 신뢰 확인이 필요합니다" };
    case "compact": return { label: "문맥 압축 대기", reason: "문맥 압축이 끝나면 입력을 전달합니다" };
    case "retry": return { label: "재시도 대기", reason: wait.retryAt ? `다음 전달 시각: ${wait.retryAt}` : "전달 재시도 시각을 기다립니다" };
    case "runner_disabled": return { label: "실행 꺼짐", reason: "프로젝트의 직원 실행이 꺼져 있습니다" };
    case "archived": return { label: "프로젝트 보관", reason: "보관된 프로젝트의 입력입니다" };
    case "backend_down": return { label: "실행기 연결 대기", reason: "직원 실행기에 연결하지 못했습니다" };
    case "session": return { label: "세션 확인 대기", reason: "세션의 소유권·실행 상태를 확인하고 있습니다" };
    case "lifecycle": return { label: "세션 준비 중", reason: "세션 생성·설정 변경이 끝나기를 기다립니다" };
    case "delivery_confirmation": return { label: "수신 확인 대기", reason: "이전 입력의 수신 여부를 확인한 뒤 다음 입력을 전달합니다" };
    case "manual_inbox": return { label: "직원 수신 대기", reason: "직원이 수신함을 확인하면 입력을 전달합니다" };
    case "sequence": return { label: "선행 업무 대기", reason: "직원에게 먼저 배정된 업무가 끝나기를 기다립니다" };
    case "quiet": return { label: "알림 보관", reason: "다음 실행 입력과 함께 전달할 알림입니다" };
    default: return { label: "입력 상태 확인", reason: "직원의 입력칸·응답 대기 상태를 확인해야 합니다" };
  }
}
