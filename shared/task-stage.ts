// 업무 단계의 화면 공통 규칙(서버·웹이 같이 쓴다). 브라우저·서버 API 를 쓰지 않는다.
import type { TaskProgress, TaskStage, WorkSec } from "./types.ts";

export const STAGE_LABEL: Record<TaskStage, string> = {
  new: "시작 전",
  working: "진행 중",
  owner: "대표 차례",
  approval: "승인 창",
  held: "전달 보류",
  check: "총괄 점검",
  fix: "고칠 것",
  confirm: "확인 대기",
  delivered: "작성자 납품",
  review: "검토 중",
  merge: "합치기 대기",
  merged: "메인 합침",
  applied: "화면 반영",
  hold: "보류",
  done: "완료",
};

/** 팀 목록에서 실제 실행만 진행 중이다. 검토·납품·적용 대기는 다음 차례로 둔다. */
export function stageSec(stage: TaskStage): WorkSec {
  return stage === "done" ? "done" : stage === "working" ? "doing" : ["hold", "held", "owner", "approval", "check"].includes(stage) ? "hold" : "next";
}

/** 누군가 다음 행동을 해야 하는 단계. 화면은 이때만 원인과 다음 차례를 보인다(늘 떠 있는 상태 문구를 늘리지 않는다). */
export function needsAction(p: Pick<TaskProgress, "stage" | "next"> & Partial<Pick<TaskProgress, "execution">> | null | undefined): boolean {
  return !!p && !!p.next && (p.stage !== "working" || !!p.execution?.background) && p.stage !== "new" && p.stage !== "done";
}

/** 늦게 온 낮은 판은 버린다. 판이 같으면 새 값을 쓴다(같은 근거로 계산한 값). */
export function newerProgress(before: TaskProgress | undefined, incoming: TaskProgress | undefined): TaskProgress | undefined {
  if (!incoming) return before;
  if (!before) return incoming;
  return incoming.rev >= before.rev ? incoming : before;
}
