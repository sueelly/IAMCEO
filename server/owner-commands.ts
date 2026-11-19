import { commandMilestones } from "./owner-command-milestones.ts";
import type { SQLQueryBindings } from "bun:sqlite";
import type { OwnerCommandItem, OwnerCommandPage } from "../shared/owner-commands.ts";
import type { DeliveryStatus, MessageKind, TaskProgress } from "../shared/types.ts";
import { ApiError, type Store } from "./store.ts";
import { deriveProgress } from "./task-progress.ts";

type Kind = "message" | "decision" | "todo" | "delivery" | "stage";
type Key = { id: string; at: string; kind: "command" | "task" };
const tables = { message: "messages", decision: "decisions", todo: "todos", delivery: "deliveries", stage: "task_stage_marks" } as const;
function rows<T>(store: Store, sql: string, ...args: SQLQueryBindings[]): T[] {
  return store.db.query<T, SQLQueryBindings[]>(sql).all(...args);
}

function runCommandInputs(store: Store, runId: string, memberId: string, projectId: string) {
  return rows<{ id: string | null; original: string | null; taskId: string | null; lost: number }>(store, `
    SELECT owner.message_id AS id,original.id AS original,d.task_id AS taskId,(d.id IS NULL OR d.status!='delivered') AS lost
    FROM execution_journal j,json_each(j.delivery_ids_json) i
    LEFT JOIN deliveries d ON d.id=i.value AND d.member_id=j.member_id AND d.project_id=j.project_id
    LEFT JOIN messages original ON d.kind='user_message' AND d.ref_type='message' AND original.id=d.ref_id AND original.project_id=j.project_id AND original.mine=1
    LEFT JOIN owner_commands c ON c.project_id=j.project_id AND d.kind='user_message' AND d.ref_type='message' AND c.message_id=d.ref_id
    LEFT JOIN owner_command_evidence e ON e.ref_type='delivery' AND e.ref_id=d.id
    LEFT JOIN owner_command_evidence origin ON origin.ref_type=d.ref_type AND origin.ref_id=d.ref_id
    LEFT JOIN owner_commands owner ON owner.message_id=COALESCE(c.message_id,e.command_id,origin.command_id) AND owner.project_id=j.project_id
    WHERE j.run_id=? AND j.member_id=? AND j.project_id=? AND j.input_received_at IS NOT NULL`, runId, memberId, projectId);
}

function commandForRun(store: Store, runId: string, memberId: string, projectId: string, selection?: CommandSelection) {
  const inputs = runCommandInputs(store,runId,memberId,projectId);
  if (selection?.matchesQuote) {
    const possible = [...new Set(inputs.flatMap(i => !i.lost && (i.id || i.original) ? [i.id ?? i.original!] : []))];
    const matches = possible.filter(id => selection.matchesQuote!(store.requireMessage(id).body));
    if (matches.length !== 1 || matches[0] !== selection.id) return null;
  }
  const matched = selection ? inputs.filter(i => i.id === selection.id) : inputs;
  const id = matched[0]?.id;
  return id && matched.every(i => !i.lost && i.id === id) ? { id, tasks: new Set(matched.flatMap(i => i.taskId ? [i.taskId] : [])) } : null;
}

export interface CommandSelection { id: string; matchesQuote?: (body: string) => boolean }

function taskInScope(store: Store, id: string | null, allowed: Set<string>): boolean {
  if (!allowed.size) return true;
  const seen = new Set<string>();
  let next = id;
  while (next && !seen.has(next)) {
    if (allowed.has(next)) return true;
    seen.add(next);
    next = store.getTask(next)?.parentTaskId ?? null;
  }
  return false;
}

/** An explicit source selects one received input from a mixed turn. A quote is advisory and never rejects an assignment. */
export function captureOwnerCommandEvidence(store: Store, memberId: string, type: Kind, refId: string, about?: string | null, selection?: CommandSelection): void {
  const fail = () => {
    if (selection && !selection.matchesQuote) throw new ApiError(400, "source_command_id 는 이 세션이 수신한 대표 명령과 보고 업무·정정 원본에 일치해야 합니다");
  };
  if (!store.db.query("SELECT 1 FROM owner_commands WHERE project_id=(SELECT project_id FROM members WHERE id=?) LIMIT 1").get(memberId)) return fail();
  const member = store.requireMember(memberId);
  const ref = rows<{ taskId: string | null }>(store, `SELECT task_id AS taskId FROM ${tables[type]} WHERE id=? AND project_id=?`, refId, member.projectId)[0];
  if (!ref) return fail();
  let commandId: string | null = null, runId: string | null = null;
  if (about) {
    commandId = rows<{ id: string }>(store, `SELECT c.message_id AS id FROM owner_command_evidence e JOIN owner_commands c ON c.message_id=e.command_id
      WHERE e.ref_type='message' AND e.ref_id=? AND c.project_id=?`, about, member.projectId)[0]?.id ?? null;
    const prior = selection ? store.getMessage(about) : null;
    if (!commandId || (selection && (selection.id !== commandId || (prior?.taskId && prior.taskId !== ref.taskId)))) return fail();
  }
  if (!about || selection) {
    const runs = rows<{ id: string; phase: string }>(store, `SELECT j.run_id AS id,j.phase FROM execution_journal j
      JOIN members m ON m.id=j.member_id AND m.project_id=j.project_id AND m.session_generation=j.generation
      WHERE j.member_id=? AND j.project_id=? AND j.phase NOT IN ('ended','interrupted')
        AND json_extract(j.terminal_identity_json,'$.terminalId') IS m.pane_id
        AND json_extract(j.terminal_identity_json,'$.sessionId') IS m.session_id LIMIT 2`, member.id, member.projectId);
    if (!runs.length && selection && !selection.matchesQuote && ref.taskId) {
      // A delayed explicit report can cite a proven receipt from this exact session and task.
      // Never use an old run to override a different current run, or to infer a source for an unmarked post.
      const earlier = rows<{ id: string }>(store, `SELECT j.run_id AS id FROM execution_journal j JOIN members m ON m.id=j.member_id
        WHERE j.member_id=? AND j.project_id=m.project_id AND j.generation=m.session_generation AND j.input_received_at IS NOT NULL
          AND j.phase IN ('ended','interrupted') AND json_extract(j.terminal_identity_json,'$.sessionId')=m.session_id
          AND json_extract(j.terminal_identity_json,'$.terminalId')=m.pane_id
          AND EXISTS (SELECT 1 FROM json_each(j.delivery_ids_json) i JOIN deliveries d ON d.id=i.value AND d.member_id=m.id AND d.project_id=m.project_id
            WHERE d.status='delivered' AND d.task_id=? AND ((d.kind='user_message' AND d.ref_type='message' AND d.ref_id=?) OR EXISTS(
              SELECT 1 FROM owner_command_evidence e WHERE e.command_id=? AND ((e.ref_type='delivery' AND e.ref_id=d.id) OR (e.ref_type=d.ref_type AND e.ref_id=d.ref_id)))))
        ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1`, member.id,ref.taskId,selection.id,selection.id);
      runId = earlier[0]?.id ?? null;
    } else if (runs.length === 1 && ["running","received"].includes(runs[0]!.phase)) {
      runId = runs[0]!.id;
    }
    if (!runId) return fail();
    const source = commandForRun(store, runId, memberId, member.projectId, selection);
    if (!source || !taskInScope(store,ref.taskId,source.tasks)) return fail();
    commandId = source.id;
  }
  if (commandId) store.db.query("INSERT OR IGNORE INTO owner_command_evidence(ref_type,ref_id,command_id,task_id,run_id) VALUES(?,?,?,?,?)")
    .run(type, refId, commandId, ref.taskId, runId);
}

export function linkOwnerReportFollowup(store: Store, runId: string, memberId: string, projectId: string, deliveryId: string) {
  const source = commandForRun(store, runId, memberId, projectId);
  if (source) store.db.query(`INSERT OR IGNORE INTO owner_command_evidence(ref_type,ref_id,command_id,task_id,run_id)
    SELECT 'delivery',id,?,task_id,? FROM deliveries WHERE id=? AND member_id=? AND project_id=?`).run(source.id, runId, deliveryId, memberId, projectId);
}

const keySet = `SELECT message_id AS id,created_at AS at,'command' AS kind FROM owner_commands WHERE project_id=$project
  UNION ALL SELECT l.task_id AS id,l.created_at AS at,'task' AS kind FROM owner_command_legacy_tasks l
  JOIN tasks t ON t.id=l.task_id AND t.project_id=l.project_id WHERE l.project_id=$project AND t.merged_into IS NULL`;

function visibleProject(store: Store, projectId: string) {
  if (store.requireProject(projectId).archived) throw new ApiError(404, "보관된 프로젝트입니다");
}

function scopeTasks(store: Store, projectId: string, k: Key) {
  if (k.kind === "task") return [k.id];
  return rows<{ id: string }>(store, `SELECT t.id FROM tasks t WHERE t.project_id=? AND t.id IN (
    SELECT task_id FROM messages WHERE id=? AND project_id=? UNION SELECT task_id FROM owner_command_evidence WHERE command_id=?)`,
    projectId, k.id, projectId, k.id).map(t => t.id);
}

interface ReportRow {
  id: string; kind: MessageKind; title: string; at: string; fileId: string | null; systemAnswer: number;
  contractRev: number | null; gate: string | null; evidenceStatus: string | null;
}
interface SourceRow { title: string; taskId: string | null; delivery: DeliveryStatus | null; deliveryNote: string | null }

function projectItems(store: Store, projectId: string, keys: Key[]): OwnerCommandItem[] {
  const scopes = keys.map(k => scopeTasks(store, projectId, k));
  const taskIds = new Set(scopes.flat());
  const stages = new Map<string, TaskProgress>();
  if (taskIds.size) {
    for (const [id, facts] of store.taskProgressFacts(projectId, taskIds)) stages.set(id, deriveProgress(facts));
  }
  return keys.map((k, index) => {
    const legacy = k.kind === "task";
    const source = rows<SourceRow>(store, legacy
      ? "SELECT title,id AS taskId,NULL AS delivery,NULL AS deliveryNote FROM tasks WHERE project_id=? AND id=?"
      : "SELECT substr(COALESCE(NULLIF(title,''),trim(body)),1,300) AS title,task_id AS taskId,delivery,delivery_note AS deliveryNote FROM messages WHERE project_id=? AND id=?",
      projectId, k.id)[0]!;
    const scope = scopes[index]!.map(id => stages.get(id)).filter((s): s is TaskProgress => !!s);
    const link = (alias: string, type: Kind) => legacy ? `${alias}.task_id=?` :
      `${alias}.id IN (SELECT ref_id FROM owner_command_evidence WHERE command_id=? AND ref_type='${type}')`;
    const report = rows<ReportRow>(store, `SELECT m.id,m.kind,m.title,m.at,m.file_id AS fileId,
      (m.member_id IS NULL AND m.about_message_id=?) AS systemAnswer,h.contract_rev AS contractRev,h.gate,h.evidence_status AS evidenceStatus
      FROM messages m LEFT JOIN report_harness h ON h.message_id=m.id
      WHERE m.project_id=? AND m.mine=0 ${legacy ? "AND m.member_id IS NOT NULL" : ""} AND ${link("m","message")}
        AND m.kind IN ('완료','답변','막힘','진행','질문','알림')
        AND NOT EXISTS(SELECT 1 FROM report_references r WHERE r.project_id=m.project_id AND r.corrects_message_id=m.id)
      ORDER BY (m.kind='알림'),m.at DESC,m.id DESC LIMIT 1`, k.id, projectId, k.id)[0];
    const references = report ? store.getReportReferences(projectId, report.id) : null;
    const result = report ? { messageId: report.id, title: report.title, kind: report.kind, at: report.at,
      fileIds: references?.fileIds ?? (report.fileId ? [report.fileId] : []) } : null;
    const questions = rows<OwnerCommandItem["questions"][number]>(store,`
      SELECT id,title,'decision' AS kind FROM decisions q WHERE q.project_id=? AND q.status='open' AND
        (${link("q","decision")} OR q.id IN (SELECT m.decision_id FROM messages m JOIN owner_command_evidence e ON e.ref_type='message' AND e.ref_id=m.id
          WHERE e.command_id=? AND m.project_id=q.project_id))
      UNION ALL SELECT id,title,'todo' AS kind FROM todos q WHERE q.project_id=? AND q.done=0 AND ${link("q","todo")}
      ORDER BY id`, projectId, k.id, k.id, projectId, k.id);
    const status = commandStatus(scope, source, questions, report, legacy);
    const milestones = commandMilestones(store, projectId, scopes[index]!, legacy ? null : k.id);
    return { id: k.id, kind: k.kind, projectId, title: source.title, taskId: source.taskId ?? (scopes[index]!.length === 1 ? scopes[index]![0]! : null), at: k.at, ...status, result, questions, milestones };
  });
}

function commandStatus(scope: TaskProgress[], source: SourceRow, questions: OwnerCommandItem["questions"], report: ReportRow | undefined, legacy: boolean):
    Pick<OwnerCommandItem,"stage" | "detail"> {
  if (report?.systemAnswer && !legacy) return { stage: "result", detail: "현재 상태를 조회해 답변했습니다." };
  if (questions.length) return { stage: "owner", detail: questions[0]!.title };
  if (report?.kind === "막힘") return { stage: "waiting", detail: report.title };
  const review = scope.find(s => s.finalReview && s.finalReview.status !== "confirmed");
  if (review?.finalReview) return review.finalReview.status === "pending"
    ? { stage: "waiting", detail: "작성자 보고를 접수했고 독립 최종 검수를 기다립니다." }
    : { stage: "working", detail: "독립 검수에서 수정을 요청했습니다." };
  const unfinished = scope.find(s => s.stage !== "done");
  if (report && (report.kind === "완료" || report.kind === "답변") && !unfinished && (scope.length || report.kind === "답변")) {
    let detail = scope.length ? "업무의 완료 표시와 결과 보고가 있습니다." : "담당자가 답변했습니다.";
    if (scope.some(s => s.finalReview?.reportId === report.id && s.finalReview.status === "confirmed")) detail = "독립 최종 검수자가 이 결과를 확인했습니다.";
    else if (report.gate === "contract" && report.contractRev) detail = `계약 ${report.contractRev}판의 완료 검사를 통과한 보고입니다.`;
    if (report.evidenceStatus === "unsupported") detail = "작성자 완료 보고를 접수했습니다. 제공자 실행 기록은 대조할 수 없습니다.";
    return { stage: "result", detail };
  }
  if (source.delivery === "held" || source.delivery === "failed") return { stage: "waiting", detail: source.deliveryNote || "대표 명령의 전달 확인을 기다립니다." };
  if (unfinished && ["held","hold","check","confirm","review","approval","owner","merged","applied"].includes(unfinished.stage)) {
    return { stage: "waiting", detail: unfinished.next || "업무 확인을 기다립니다." };
  }
  if (report || legacy || source.delivery === "delivered") return { stage: "working", detail: unfinished?.next || report?.title || "담당자가 명령을 받았습니다." };
  return { stage: "accepted", detail: "명령을 접수했습니다." };
}

export function ownerCommandPage(store: Store, projectId: string, limit: number, cursor?: string): OwnerCommandPage {
  visibleProject(store, projectId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, "명령 조회 개수가 올바르지 않습니다");
  let before: { id: string; at: string } | null = null;
  if (cursor !== undefined) {
    try {
      if (!cursor.length || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
      const token = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (token.v !== 1 || token.projectId !== projectId || typeof token.id !== "string" || !token.id || typeof token.at !== "string" || !token.at) throw Error();
      before = token;
    } catch { throw new ApiError(400,"명령 조회 위치가 올바르지 않습니다"); }
  }
  return store.transaction(() => {
    const keys = store.db.query<Key,{ $project: string; $limit: number; $at?: string; $id?: string }>(`SELECT * FROM (${keySet}) ${before ? "WHERE (at,id)<($at,$id)" : ""} ORDER BY at DESC,id DESC LIMIT $limit`)
      .all({ $project: projectId, $limit: limit+1, ...(before ? { $at: before.at, $id: before.id } : {}) });
    const page = keys.slice(0,limit), last = page.at(-1);
    return { items: projectItems(store, projectId, page), nextCursor: keys.length > limit && last ? Buffer.from(JSON.stringify({ v:1, projectId, at:last.at, id:last.id })).toString("base64url") : null };
  });
}

export function ownerCommandItem(store: Store, projectId: string, id: string): OwnerCommandItem {
  visibleProject(store, projectId);
  return store.transaction(() => {
    const key = store.db.query<Key,Record<string,string>>(`SELECT * FROM (${keySet}) WHERE id=$id`).get({ $project:projectId, $id:id });
    if (!key) throw new ApiError(404,"대표 명령이나 이전 업무를 찾을 수 없습니다");
    return projectItems(store, projectId,[key])[0]!;
  });
}
