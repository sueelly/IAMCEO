// '멈춤'과 '멈추고 이어서'의 화면 공용 계산. 서버 계약: POST /api/members/:id/stop (StopReq → StopResult).
// 멈춤은 직원 한 명의 지금 CLI 턴 단위다. 그 턴이 받은 작업이 여럿이면 함께 멈춘다(작업 하나만 따로 멈추지 않는다).
import type { Member, MemberExecutionState, StopReq, StopResult, Task } from "@shared/types";

/** 지금 도는 실행(끝나지 않은 것). 끝난 실행은 멈출 대상이 아니다. */
export function liveRun(m: Member): MemberExecutionState | null {
  const e = m.executionState ?? null;
  return e && e.phase !== "ended" && e.phase !== "interrupted" ? e : null;
}

/** 멈출 수 있는 상태인가. 일하는 중이거나 승인 창 앞(blocked)일 때만. */
export function canStop(m: Member | null | undefined): m is Member {
  return !!m && m.origin !== "manual" && (m.status === "working" || m.status === "blocked");
}

/** 화면에서 본 실행·세대. 서버는 지금과 다르면 멈추지 않는다(다른 턴을 끊지 않는다). 대표가 터미널에 직접 친 턴처럼 실행 기록이 없으면 세대만 본다. */
export function stopExpectation(m: Member): StopReq {
  return { expectRunId: liveRun(m)?.runId ?? null, expectGeneration: m.executionState?.sessionGeneration ?? null };
}

const short = (id: string) => id.slice(0, 8);

function taskNames(ids: readonly string[], tasks: readonly Task[]): string {
  if (!ids.length) return "전체";
  return ids.map((id) => tasks.find((t) => t.id === id)?.title ?? `#${id}`).join(", ");
}

/** "실행 1a2b3c4d · 작업: 전체" — 무엇이 멈추는지 누르기 전에 보인다. */
export function runLabel(m: Member, tasks: readonly Task[]): string {
  const run = liveRun(m);
  return [run ? `실행 ${short(run.runId)}` : "지금 턴", `작업: ${taskNames(run?.taskIds ?? [], tasks)}`].join(" · ");
}

/** 결과 안내. followUp: 이어서 보낼 글을 먼저 대기열에 넣었는가. */
export function stopNotice(r: StopResult, tasks: readonly Task[], followUp: boolean): string {
  const run = r.runId ? `실행 ${short(r.runId)}` : "지금 턴";
  const work = r.taskIds.length ? `(작업: ${taskNames(r.taskIds, tasks)})` : "";
  switch (r.outcome) {
    case "stopped":
      return `${r.memberName}의 ${run}${work}을 멈췄습니다. 대화·바뀐 파일은 그대로이고 끊긴 일은 다시 보내지 않습니다.${followUp ? " 보낸 글은 입력이 가능해지면 한 번 전달됩니다." : ""}`;
    case "not_running":
      return `${r.memberName}: 멈출 턴이 없습니다(${r.detail ?? "이미 끝남"}).${followUp ? " 보낸 글은 대기열 순서대로 전달됩니다." : ""}`;
    case "changed":
      return `${r.memberName}: ${r.detail ?? "실행이 바뀌어 멈추지 않았습니다"}.${followUp ? " 보낸 글은 대기열에 그대로 있습니다." : " 상태를 보고 다시 눌러 주세요."}`;
    default:
      return `${r.memberName}: ${r.detail ?? "멈추지 못했습니다"}. 지금 턴은 계속됩니다.${followUp ? " 보낸 글은 그 턴이 끝나면 전달됩니다." : ""}`;
  }
}
