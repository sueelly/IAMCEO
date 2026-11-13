// 업무가 없던 옛 글(글·결재·자료·할 일)에 업무를 붙이는 정리. 계획(plan) → 적용(apply) → 되돌리기(undo) 세 단계다.
// 원칙: 원문(id·본문·시각·보낸 이·당시 승인)은 바꾸지 않고 업무 칸만 바꾼다. 바꾼 것은 모두 task_links 에 남아 묶음(batch) 단위로 되돌린다.
// 기존 업무에는 바뀌지 않는 증거(이어 준 결재·자료·정정 대상, 그 글을 쓴 실행이 받은 업무가 하나뿐)가 있을 때만 붙인다.
// 증거가 없으면 제목·시각으로 기존 업무를 짐작하지 않고, 같은 대표 글에서 나온 글끼리(또는 같은 실행의 글끼리) 묶어 새 업무로 나눈다.
// 한 업무 '기타'로 몰지 않는다. 서버 알림(시스템 글)은 업무를 붙이지 않고 남긴다. 본사는 업무를 쓰지 않아 건너뛴다.
import type { Store, TaskRefType } from "./store.ts";
import { newId } from "./db.ts";
import { datedTitle, scrubTaskText, taskTitleFrom } from "./task-names.ts";

export type BackfillAction = "link" | "new" | "leave";

export interface BackfillItem {
  refType: TaskRefType;
  refId: string;
  at: string;
  who: string;
  /** 글 종류(대표 글은 '나'). */
  kind: string;
  /** 비밀값·주소를 지운 앞부분(검토용). */
  preview: string;
  action: BackfillAction;
  /** link: 붙일 기존 업무. */
  taskId: string | null;
  /** new: 묶음 키(같은 키는 한 새 업무). */
  group: string | null;
  /** 근거: decision·file·correction·question·run(실행이 받은 업무 하나)·thread(같은 대표 글에서 나옴)·same-run·own·system. */
  basis: string;
}

export interface BackfillGroup {
  key: string;
  title: string;
  root: { refType: TaskRefType; refId: string };
  size: number;
}

export interface BackfillPlan {
  projectId: string;
  createdAt: string;
  items: BackfillItem[];
  groups: BackfillGroup[];
  counts: { link: number; new: number; leave: number; groups: number };
}

export interface BackfillResult {
  batchId: string;
  linked: number;
  createdTasks: number;
  /** 계획 뒤에 이미 업무가 붙었거나 바뀌어 건너뛴 기록. */
  skipped: { refType: TaskRefType; refId: string }[];
}

export interface BackfillUndoResult {
  batchId: string;
  restored: number;
  /** 적용 뒤에 업무가 다시 바뀌어 되돌리지 않은 기록. */
  conflicts: { refType: TaskRefType; refId: string; now: string | null }[];
  removedTasks: number;
  /** 다른 기록이 붙어 지우지 않은 업무. */
  keptTasks: string[];
}

type Row = Record<string, any>;

interface Run { runId: string; memberId: string; from: string; to: string; deliveryIds: string[] }

/** 지시 인용 줄의 출처 id: 서버 id(msg_·d_) 또는 화면이 만든 글 id(UUID). '결재 #' 이면 결재. */
const SOURCE_ID = /(결재 )?#((?:msg|d)_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

/** 실행 끝과 그 턴의 마지막 글(자동 보고) 사이의 틈. */
const RUN_SLACK_MS = 15_000;

function preview(text: string): string {
  const one = scrubTaskText(text.replace(/\s+/g, " "));
  return [...one].length > 60 ? `${[...one].slice(0, 59).join("")}…` : one;
}

/** 계획: DB 를 읽기만 한다. */
export function planTaskBackfill(store: Store, projectId: string): BackfillPlan {
  const db = store.db;
  const project = store.requireProject(projectId);
  const createdAt = new Date().toISOString();
  if (project.isHq) return { projectId, createdAt, items: [], groups: [], counts: { link: 0, new: 0, leave: 0, groups: 0 } };
  const all = <T = Row>(sql: string, ...p: any[]) => db.query(sql).all(...p) as T[];
  const one = (sql: string, ...p: any[]) => db.query(sql).get(...p) as Row | null;

  const messages = all("SELECT id, at, mine, member_id, who, kind, title, body, decision_id, file_id, task_id FROM messages WHERE project_id = ? ORDER BY at, rowid", projectId);
  const decisions = all("SELECT id, created_at, member_id, who, title, file_id, task_id FROM decisions WHERE project_id = ? ORDER BY created_at, rowid", projectId);
  const files = all("SELECT id, created_at, member_id, who, title, task_id FROM files WHERE project_id = ? ORDER BY created_at, rowid", projectId);
  const todos = all("SELECT id, created_at, member_id, who, title, task_id FROM todos WHERE project_id = ? ORDER BY created_at, rowid", projectId);
  const corrections = new Map(all("SELECT source_message_id, corrects_message_id FROM report_references WHERE project_id = ? AND corrects_message_id IS NOT NULL", projectId)
    .map(r => [r.source_message_id as string, r.corrects_message_id as string]));
  const runs: Run[] = all("SELECT run_id, member_id, created_at, COALESCE(ended_at, updated_at) AS to_at, delivery_ids_json FROM execution_journal WHERE project_id = ? ORDER BY created_at", projectId)
    .map(r => ({ runId: r.run_id, memberId: r.member_id, from: r.created_at, to: r.to_at, deliveryIds: JSON.parse(r.delivery_ids_json || "[]") as string[] }));
  const messageById = new Map(messages.map(m => [m.id as string, m]));
  const decisionById = new Map(decisions.map(d => [d.id as string, d]));
  const fileById = new Map(files.map(f => [f.id as string, f]));
  const delivery = (id: string) => one("SELECT task_id, ref_type, ref_id, kind, text FROM deliveries WHERE id = ?", id);

  const key = (refType: TaskRefType, refId: string) => `${refType}:${refId}`;
  const items = new Map<string, BackfillItem>();
  const add = (refType: TaskRefType, r: Row, at: string, kind: string, text: string) => {
    items.set(key(refType, r.id), { refType, refId: r.id, at, who: r.who ?? "", kind, preview: preview(text), action: "new", taskId: null, group: null, basis: "own" });
  };
  for (const m of messages) if (!m.task_id) add("message", m, m.at, m.kind, [m.title, m.body].filter(Boolean).join(" — "));
  for (const d of decisions) if (!d.task_id) add("decision", d, d.created_at, "결재", d.title);
  for (const f of files) if (!f.task_id) add("file", f, f.created_at, "자료", f.title);
  for (const t of todos) if (!t.task_id) add("todo", t, t.created_at, "할 일", t.title);

  const link = (item: BackfillItem, taskId: string, basis: string) => {
    item.action = "link"; item.taskId = taskId; item.basis = basis;
  };
  /** 이 직원이 이 시각에 하던 실행(하나일 때만). */
  const runAt = (memberId: string | null, at: string): Run | null => {
    if (!memberId) return null;
    const t = Date.parse(at);
    const mine = runs.filter(r => r.memberId === memberId);
    // 그 시각을 품은 실행이 먼저다. 없을 때만 실행 끝 바로 뒤(턴 마지막 글)의 틈을 본다. 둘 이상이면 짐작하지 않는다.
    const inside = mine.filter(r => Date.parse(r.from) <= t && t <= Date.parse(r.to));
    const hits = inside.length ? inside : mine.filter(r => Date.parse(r.to) < t && t <= Date.parse(r.to) + RUN_SLACK_MS);
    return hits.length === 1 ? hits[0]! : null;
  };
  /** 실행이 받은 전달에서: 붙어 있던 기존 업무들, 업무 없던 대표 글·결재(새 묶음의 뿌리 후보). */
  const runSources = (run: Run) => {
    const tasks = new Set<string>();
    const roots = new Set<string>();
    const fromMessage = (id: string) => {
      const m = messageById.get(id);
      if (!m) return;
      if (m.task_id) tasks.add(m.task_id); else if (items.has(key("message", id)) && m.kind !== "시스템") roots.add(key("message", id));
    };
    const fromDecision = (id: string) => {
      const dec = decisionById.get(id);
      if (!dec) return;
      if (dec.task_id) tasks.add(dec.task_id); else if (items.has(key("decision", id))) roots.add(key("decision", id));
    };
    for (const id of run.deliveryIds) {
      const d = delivery(id);
      if (!d) continue;
      if (d.task_id) { tasks.add(d.task_id); continue; }
      // 대표 글·결재 답·직원 보고(총괄이 받은 것)는 전달이 그 기록을 가리킨다.
      if (d.ref_type === "message") fromMessage(d.ref_id);
      else if (d.ref_type === "decision") fromDecision(d.ref_id);
      else if (d.kind === "instruction") {
        // 총괄 지시: 서버가 확인해 붙인 인용 줄(할 일: 줄 앞)의 대표 글·결재 id 만 증거로 친다. 총괄이 쓴 글(할 일: 뒤)은 보지 않는다.
        const head = String(d.text ?? "").split("\n할 일:")[0] ?? "";
        for (const line of head.split("\n")) {
          if (!/^(사용자 요청\(원문, 서버 확인\)|사용자 요청\(문맥 확인 필요\)|대표 글 전문 )/.test(line)) continue;
          for (const [, kind, id] of line.matchAll(SOURCE_ID)) (kind || id!.startsWith("d_") ? fromDecision : fromMessage)(id!);
        }
      } else if (d.kind === "system") {
        // 서버가 쓴 첫 줄의 '대표가 ○○에게 직접 지시했습니다 #글' · '○○이 대표에게 질문했습니다: … #결재'만 본다.
        const first = String(d.text ?? "").split("\n")[0] ?? "";
        const direct = /^\[시스템\] 대표가 .+에게 직접 지시했습니다 #([^\s(.]+)/.exec(first);
        const asked = /^\[시스템\] .+ 대표에게 질문했습니다: .* #(d_[A-Za-z0-9]+)$/.exec(first);
        if (direct) fromMessage(direct[1]!);
        else if (asked) fromDecision(asked[1]!);
      }
    }
    return { tasks, roots };
  };
  const rowOf = (item: BackfillItem): Row | undefined => item.refType === "message" ? messageById.get(item.refId) : item.refType === "decision" ? decisionById.get(item.refId)
    : item.refType === "file" ? fileById.get(item.refId) : todos.find(t => t.id === item.refId);

  // 1) 기록마다 증거. 굳은 짝(질문 글↔결재, 글↔이어 준 자료, 정정 글↔정정 대상)은 같은 업무에 둔다.
  const hard: [string, string][] = [];
  const soft = new Map<string, string>(); // 기록 → 같은 대표 글·결재 뿌리(thread)
  const sameRun = new Map<string, string>(); // 기록 → 실행 키
  for (const item of items.values()) {
    const k = key(item.refType, item.refId);
    if (item.refType === "message") {
      const m = messageById.get(item.refId)!;
      if (m.kind === "시스템") { item.action = "leave"; item.basis = "system"; continue; }
      const dec = m.decision_id ? decisionById.get(m.decision_id) : null;
      const file = m.file_id ? fileById.get(m.file_id) : null;
      const corrected = corrections.get(m.id) ? messageById.get(corrections.get(m.id)!) : null;
      const fixed = new Set([dec?.task_id, file?.task_id, corrected?.task_id].filter(Boolean) as string[]);
      if (fixed.size === 1) { link(item, [...fixed][0]!, dec?.task_id ? "decision" : file?.task_id ? "file" : "correction"); continue; }
      if (fixed.size > 1) continue; // 굳은 출처끼리 다르면 짐작하지 않고 따로 둔다.
      if (dec) hard.push([k, key("decision", dec.id)]);
      if (file) hard.push([k, key("file", file.id)]);
      if (corrected) hard.push([k, key("message", corrected.id)]);
      if (m.mine) continue; // 대표 글은 그 자체가 새 묶음의 뿌리다.
    }
    if (item.refType === "decision") {
      const d = decisionById.get(item.refId)!;
      const file = d.file_id ? fileById.get(d.file_id) : null;
      if (file?.task_id) { link(item, file.task_id, "file"); continue; }
      if (file) hard.push([k, key("file", file.id)]);
    }
    const run = runAt(rowOf(item)?.member_id ?? null, item.at);
    if (!run) continue;
    const { tasks, roots } = runSources(run);
    if (tasks.size === 1 && roots.size === 0) { link(item, [...tasks][0]!, "run"); continue; }
    if (tasks.size === 0 && roots.size === 1) { soft.set(k, [...roots][0]!); item.basis = "thread"; continue; }
    // 여러 업무·여러 대표 글을 받은 실행, 받은 글에 업무가 없던 실행: 짐작하지 않고 그 실행의 글끼리 새 업무로 묶는다.
    sameRun.set(k, `run:${run.runId}`);
    item.basis = "same-run";
  }
  // 2) 굳은 짝은 한쪽이 기존 업무로 가면 다른 쪽도 따라간다(서로 다른 업무면 둘 다 그대로).
  for (let changed = true; changed;) {
    changed = false;
    for (const [a, b] of hard) {
      const ia = items.get(a), ib = items.get(b);
      if (!ia || !ib) continue;
      if (ia.action === "link" && ib.action === "new") { link(ib, ia.taskId!, "pair"); changed = true; }
      else if (ib.action === "link" && ia.action === "new") { link(ia, ib.taskId!, "pair"); changed = true; }
    }
  }
  // 3) 남은 기록을 묶는다(union-find): 굳은 짝 · 같은 대표 글·결재에서 나온 글 · 같은 실행의 글.
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    if (r !== k) parent.set(k, r);
    return r;
  };
  const join = (a: string, b: string) => {
    const ia = items.get(a), ib = items.get(b);
    if (!ia || !ib || ia.action !== "new" || ib.action !== "new") return;
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // 대표 글이 있으면 대표 글을, 아니면 먼저 생긴 기록을 뿌리로 둔다.
    const ra_ = items.get(ra)!, rb_ = items.get(rb)!;
    const aFirst = (ra_.kind === "나") !== (rb_.kind === "나") ? ra_.kind === "나" : ra_.at <= rb_.at;
    if (aFirst) parent.set(rb, ra); else parent.set(ra, rb);
  };
  for (const [a, b] of hard) join(a, b);
  for (const [k, root] of soft) join(root, k);
  const firstOfRun = new Map<string, string>();
  for (const [k, run] of sameRun) {
    const first = firstOfRun.get(run);
    if (first) join(first, k); else firstOfRun.set(run, k);
  }
  const groupsByRoot = new Map<string, BackfillItem[]>();
  for (const item of items.values()) {
    if (item.action !== "new") continue;
    const k = key(item.refType, item.refId);
    const root = find(k);
    item.group = root;
    if (item.basis === "own" && root !== k) item.basis = "pair";
    groupsByRoot.set(root, [...(groupsByRoot.get(root) ?? []), item]);
  }
  const groups: BackfillGroup[] = [...groupsByRoot.entries()].map(([groupKey, members]) => {
    const root = items.get(groupKey)!;
    const fallback = datedTitle(root.kind === "나" ? "대표 글" : root.refType === "file" ? "자료" : `${root.who || "직원"} 글`, root.at);
    const source = root.refType === "message" ? messageById.get(root.refId)! : null;
    const text = source ? (source.mine ? source.body : source.title || source.body) : root.refType === "file" ? `자료 ${fileById.get(root.refId)?.title ?? ""}` : root.refType === "decision" ? decisionById.get(root.refId)?.title ?? "" : todos.find(t => t.id === root.refId)?.title ?? "";
    return { key: groupKey, title: taskTitleFrom(text, fallback), root: { refType: root.refType, refId: root.refId }, size: members.length };
  }).sort((a, b) => (items.get(a.key)!.at < items.get(b.key)!.at ? -1 : 1));
  const list = [...items.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    projectId, createdAt, items: list, groups,
    counts: { link: list.filter(i => i.action === "link").length, new: list.filter(i => i.action === "new").length, leave: list.filter(i => i.action === "leave").length, groups: groups.length },
  };
}

/**
 * 적용: 계획대로 업무 칸만 바꾼다. 계획 뒤에 업무가 붙은 기록은 건너뛴다(덮어쓰지 않는다). 새 업무는 묶음 키로 한 번만 만든다
 * (같은 계획을 두 번 적용해도 업무가 늘지 않는다). 모든 변경은 한 묶음 id 로 task_links 에 남는다.
 */
export function applyTaskBackfill(store: Store, plan: BackfillPlan, actor = "backfill"): BackfillResult {
  const batchId = newId("tb_");
  const skipped: BackfillResult["skipped"] = [];
  let linked = 0;
  let createdTasks = 0;
  store.transaction(() => {
    const groupTask = new Map<string, string>();
    for (const g of plan.groups) {
      const { task, created } = store.ensureSourceTask({ projectId: plan.projectId, sourceRef: `backfill:${g.key}`, title: g.title, origin: "backfill" });
      groupTask.set(g.key, task.id);
      if (created) {
        createdTasks++;
        store.noteTaskCreated(plan.projectId, task.id, batchId, actor);
      }
    }
    for (const item of plan.items) {
      if (item.action === "leave") continue;
      const to = item.action === "link" ? item.taskId : groupTask.get(item.group ?? "") ?? null;
      if (!to) continue;
      const moved = store.moveRecordTask({ projectId: plan.projectId, refType: item.refType, refId: item.refId, from: null, to, basis: `backfill-${item.basis}`, actor, batchId, note: item.action === "new" ? `묶음 ${item.group}` : null });
      if (moved) linked++; else skipped.push({ refType: item.refType, refId: item.refId });
    }
  }, "immediate");
  return { batchId, linked, createdTasks, skipped };
}

/**
 * 되돌리기: 그 묶음이 바꾼 기록을 바꾸기 전 업무로 돌린다. 적용 뒤에 다시 바뀐 기록은 건드리지 않고 알린다.
 * 그 묶음이 만든 업무는 아무 기록도 남지 않았을 때만 지운다.
 */
export function undoTaskBackfill(store: Store, projectId: string, batchId: string, actor = "backfill-undo"): BackfillUndoResult {
  const conflicts: BackfillUndoResult["conflicts"] = [];
  const keptTasks: string[] = [];
  let restored = 0;
  let removedTasks = 0;
  store.transaction(() => {
    const links = store.listTaskLinks(projectId).filter(l => l.batchId === batchId && !l.undoneAt);
    for (const l of links) {
      if (l.refType === "task") continue;
      const refType = l.refType as TaskRefType;
      const moved = store.moveRecordTask({ projectId, refType, refId: l.refId, from: l.toTaskId, to: l.fromTaskId, basis: "undo", actor, note: `되돌림 ${batchId}` });
      if (moved) { restored++; store.markTaskLinkUndone(l.id); }
      else conflicts.push({ refType, refId: l.refId, now: store.recordTaskId(refType, l.refId) ?? null });
    }
    for (const l of links) {
      if (l.refType !== "task" || l.basis !== "backfill-created") continue;
      if (store.deleteTaskIfEmpty(l.refId)) { removedTasks++; store.markTaskLinkUndone(l.id); }
      else keptTasks.push(l.refId);
    }
  }, "immediate");
  return { batchId, restored, conflicts, removedTasks, keptTasks };
}
