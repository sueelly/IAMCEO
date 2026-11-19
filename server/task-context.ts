import type { Task } from "../shared/types.ts";
import { bindingContract } from "./harness.ts";
import type { Store } from "./store.ts";
import type { ProgressFacts } from "./task-progress.ts";

const quote = (text: string): string => text.split(/\r?\n/).map(line => `> ${line}`).join("\n");

/** Stored context, not an inferred summary. Do not truncate scope restrictions
 * or treat missing records as proof of failure. Used only when composing text. */
export function describeTaskContext(store: Store, task: Task, options: { sourceDeliveryId?: string | null; facts?: ProgressFacts } = {}): string {
  const project = store.getProject(task.projectId);
  const sourceId = options.sourceDeliveryId === undefined
    ? (store.db.query(`SELECT id FROM deliveries WHERE project_id=? AND task_id=? AND wake=1
        AND kind IN ('user_message','instruction') AND status='delivered'
        ORDER BY CASE WHEN kind='user_message' THEN 0 ELSE 1 END, scope_seq DESC LIMIT 1`)
      .get(task.projectId, task.id) as { id: string } | null)?.id
    : options.sourceDeliveryId;
  const foundSource = sourceId ? store.getDelivery(sourceId) : null;
  const source = foundSource?.projectId === task.projectId && foundSource.taskId === task.id &&
    ["user_message", "instruction"].includes(foundSource.kind) ? foundSource : null;
  const contract = store.getEffectiveContract(task.id);
  const facts = options.facts ?? store.taskProgressFacts(task.projectId, new Set([task.id])).get(task.id);
  const outcome = facts?.reports.findLast(r => r.kind === "완료" || r.kind === "막힘" || r.continuesWork);
  const latest = facts?.reports.at(-1);
  const reports = [...new Map([outcome, latest].filter(r => !!r).map(r => [r.id, r])).values()];
  const lines = [`프로젝트: ${project?.name ?? "이름을 확인하지 못했습니다"}`, `업무: ${task.title}`];
  if (contract) {
    lines.push(`요청한 결과${bindingContract(contract) ? "" : "(직원 제안, 미확정)"}: ${contract.goal}`);
  }
  lines.push("");
  if (source) {
    const recipient = store.getMember(source.memberId);
    lines.push(`${source.kind === "user_message" ? "최근 대표 요청" : "최근 직원 배정 요청"} 원문 · ${source.createdAt} · 받는 직원: ${recipient?.name ?? "현재 직원 이름을 확인하지 못했습니다"}`,
      quote(source.text), `출처: 이 업무의 전달 ID ${source.id}`);
  } else {
    lines.push("이 업무에 연결된 요청 원문을 확인하지 못했습니다. 총괄이 요청 내용과 허용 범위를 먼저 확인해야 합니다.");
  }
  if (contract) {
    lines.push("", `${bindingContract(contract) ? "확정된 완료 기준" : "직원 제안 완료 기준(미확정)"} · r${contract.rev} · ${contract.at}`,
      ...contract.acceptance.map((criterion, i) => `${i + 1}. ${criterion}`));
    if (contract.taskId !== task.id) {
      const parent = store.getTask(contract.taskId);
      lines.push(`기준의 출처: 상위 업무 ‘${parent?.title ?? "이름 미확인"}’(업무 ID ${contract.taskId})`);
    }
    if (contract.scope) lines.push(`허용 범위: ${contract.scope}`);
    if (contract.forbidden.length) lines.push("제외·금지 범위:", ...contract.forbidden.map(rule => `- ${rule}`));
    lines.push("위 목록은 기록된 기준 전체입니다. 각 기준의 충족 여부는 아래 보고·검사 기록과 대조해야 합니다.");
  } else {
    lines.push("", "완료 기준이 등록되지 않았습니다. 총괄이 확인된 요청 범위에서 판정 가능한 기준을 정해야 합니다.");
  }
  let reportCount = 0;
  for (const fact of reports) {
    const message = store.getMessage(fact.id);
    const checkpoint = message ? null : store.getCheckpoint(fact.id);
    const record = message ?? checkpoint;
    if (!record || record.projectId !== task.projectId || record.taskId !== task.id) continue;
    reportCount++;
    if (message) {
      lines.push("", `최근 보고: ${message.who} · ${message.kind} · ${message.at}`, `보고 제목: ${message.title}`, quote(message.body), `출처: 보고 메시지 ID ${message.id}`);
    } else {
      lines.push("", `담당자가 이어서 수행할 작업: ${fact.who} · ${record.at}`, quote(record.title), quote(record.body), `출처: 내부 작업 기록 ID ${record.id}`);
    }
    const checks = checkpoint?.checks ?? store.getReportHarness(fact.id)?.checks ?? [];
    if (checks.length) {
      lines.push(checkpoint ? "작업 기록의 검사 결과:" : "이 보고에 기록된 검사 결과:", ...checks.map(check => `- ${check.name}: ${check.result === "pass" ? "통과 보고" : check.result === "fail" ? "실패 보고" : "미실행"} — ${check.evidence}`));
    } else if (message) {
      lines.push("이 보고에 연결된 구조화된 검사 기록은 없습니다. 보고 본문만으로 검사 통과를 확정하지 않습니다.");
    }
  }
  if (!reportCount) lines.push("", "이 업무에 연결된 보고가 없습니다. 현재 수행 결과와 미확인 대상을 확인하지 못했습니다.");
  const mark = facts?.marks.at(-1);
  if (mark) lines.push("", `최근 단계 기록: ${mark.who} · ${mark.stage} · ${mark.at}`, quote(mark.evidence));
  const decisions = store.listAllDoneDecisions(task.projectId).filter(d => d.taskId === task.id &&
    (["answered", "delivered"].includes(d.status) || d.closeKind === "decided" && d.closeQuote))
    .sort((a, b) => (a.answeredAt ?? a.closedAt ?? a.updatedAt).localeCompare(b.answeredAt ?? b.closedAt ?? b.updatedAt)).slice(-3);
  for (const decision of decisions) {
    lines.push("", `최근 대표 결정: ${decision.title} · ${decision.answeredAt ?? decision.closedAt ?? decision.updatedAt}`,
      quote([decision.options.find(o => o.k === decision.choice)?.label, decision.note, decision.closeQuote].filter(Boolean).join(" / ")),
      `출처: 결재 ID ${decision.id}`);
  }
  lines.push("", `업무 식별자: ${task.id}`);
  return lines.join("\n");
}
