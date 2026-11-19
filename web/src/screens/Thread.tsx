// 대화: 보고와 내 말을 시간순으로. 본문 스크롤은 Shell 의 data-scroll-root 가 맡는다.
import NativePromptCard from "../components/NativePromptCard";
import WorkFlow from "../components/WorkFlow";
import { useRecentAnswers } from "../lib/nativeAnswers";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Decision, FileDoc, Member, Message, Task } from "@shared/types";
import { GlassButton } from "../glass";
import { api, errorText } from "../lib/api";
import { mergeHistoryMessages } from "../lib/history";
import { chooseTask, useSubmissionDraft } from "../lib/submission-client";
import { getState, loadOlderMessages, routeHash, sendMessage, useProject, useStore } from "../lib/store";
import { Attachments } from "../components/Attachments";
import { Badge, Empty, Markdown, Time } from "../components/ui";
import { kindTone } from "../lib/tone";
import { workIdOf } from "../lib/tasks";
import { needsAction, taskStageLabel } from "@shared/task-stage";
import { cardCopyText, foldLabel, foldPreview, foldThread, isCardCopy, splitOwnerAction, splitOwnerLine, type KindOf, type ThreadItem } from "../lib/thread-view";
import { useGate } from "../components/ConnectGate";
import { HqLeadStrip } from "./Inbox";
import "../styles/thread.css";

const PIN_DISTANCE = 80;
const LOAD_OLDER_DISTANCE = 480;

const distanceFromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

function deliveryLabel(m: Message): { text: string; tone: "muted" | "ok" | "warn" | "danger" } | null {
  const reason = m.deliveryNote ? ` · ${m.deliveryNote}` : "";
  switch (m.delivery) {
    case "queued":
      return { text: `대기${reason}`, tone: "muted" };
    case "delivering":
      return { text: `보냄${reason}`, tone: "muted" };
    case "held":
      return { text: `보류${reason}`, tone: "warn" };
    case "delivered":
      return { text: "받음", tone: "ok" };
    case "failed":
      return { text: `실패${reason}`, tone: "danger" };
    case null:
      return null;
  }
}

/** 같은 id 로 다시 보낸다. 서버가 받지 못했으면 새로 만들고, 받아서 실패로 끝낸 글이면 그 글을 다시 넣는다. 어느 쪽이든 이 줄이 바뀌어 지시가 늘지 않는다. */
async function resend(m: Message): Promise<void> {
  await sendMessage({ id: m.id, text: m.body, targetMemberId: m.targetMemberId, attachmentIds: m.attachments.map((a) => a.id), taskId: m.taskId ?? null }, { targetName: m.targetName, attachments: m.attachments });
}

const TASK_PAGE = 50;

/**
 * 고른 작업의 글. 서버의 작업별 페이지로 받고, 그 뒤에 온 글(실시간·내가 보낸 글)은 프로젝트 글에서 같은 작업 것만 더한다.
 * 작업을 바꾸면 처음부터 다시 받는다. 늦게 온 이전 작업의 응답은 버린다.
 */
function useTaskHistory(projectId: string, taskId: string | null) {
  const [state, setState] = useState<{ key: string | null; items: Message[]; cursor: string | null; hasOlder: boolean; busy: boolean; error: string | null }>(
    { key: null, items: [], cursor: null, hasOlder: false, busy: false, error: null });
  const key = taskId ? `${projectId}\n${taskId}` : null;
  const current = useRef(key);
  current.current = key;
  const load = useCallback(async (cursor: string | null) => {
    if (!key || !taskId) return;
    setState((s) => ({ ...(s.key === key ? s : { key, items: [], cursor: null, hasOlder: false }), busy: true, error: null }));
    try {
      const page = await api.messagePage(projectId, { scope: { kind: "task", taskId }, limit: TASK_PAGE, ...(cursor ? { cursor } : {}) });
      if (current.current !== key) return;
      setState((s) => ({ key, items: mergeHistoryMessages(s.key === key ? s.items : [], page.items.filter((m) => m.taskId === taskId)), cursor: page.nextCursor, hasOlder: page.hasOlder, busy: false, error: null }));
    } catch (e) {
      if (current.current !== key) return;
      setState((s) => ({ ...s, key, busy: false, error: errorText(e) }));
    }
  }, [projectId, taskId, key]);
  useEffect(() => {
    if (key) void load(null);
  }, [key, load]);
  const fresh = state.key === key ? state : { key, items: [], cursor: null, hasOlder: false, busy: !!key, error: null };
  return { ...fresh, loadOlder: () => (fresh.cursor && !fresh.busy ? load(fresh.cursor) : Promise.resolve()) };
}

function TaskBar({ task, expanded, onFlow }: { task: Task; expanded: boolean; onFlow: () => void }) {
  return (
    <div className="th-task" role="note">
      <span className="th-task__label">업무</span>
      <span className="th-task__title">{task.title}</span>
      <GlassButton variant="ghost" size="s" className="wf-toggle" aria-expanded={expanded} onClick={onFlow}>업무 흐름</GlassButton>
      {/* 맡은 직원은 적지 않는다. 업무에는 여러 직원이 붙고, 누가 썼는지는 글마다 보인다. */}
      {task.branch || task.worktree ? <span className="th-task__meta">{[task.branch, task.worktree].filter(Boolean).join(" · ")}</span> : null}
      {/* 단계는 누가 무엇을 해야 할 때와 끝났을 때만 적는다(늘 떠 있는 상태 글을 늘리지 않는다). 팀 목록과 같은 값이다. */}
      {task.progress?.stage === "done" ? <span className="th-task__stage" data-stage="done">{task.progress.finalReview?.status === "pending" ? "수행 완료 · 최종 검수 대기" : taskStageLabel(task.progress)}</span> : null}
      {needsAction(task.progress) ? (
        <span className="th-task__next" data-stage={task.progress!.stage}>
          <b>{taskStageLabel(task.progress!)}</b> {task.progress!.next}
        </span>
      ) : null}
    </div>
  );
}

/** 빈 업무 칩의 안내. 받는 사람은 업무가 아니라 입력칸에서 고른 사람이다. 일 목록에서 생긴 칩은 '이 업무로 보낸 글만 모인다'를 먼저 알린다. */
function emptyTaskText(task: Task, members: readonly Member[], targetId: string | null): string {
  const worker = targetId ? members.find((m) => m.kind === "worker" && m.id === targetId) : undefined;
  const to = worker?.name ?? members.find((m) => m.kind === "root" || m.kind === "conductor")?.name ?? "총괄";
  const send = `아래 입력칸에 적으면 이 업무로 ${to}에게 갑니다.`;
  if (!workIdOf(task)) return `${send} 전체 대화는 입력칸 위 ‘전체’에서 봅니다.`;
  return `팀 화면 일 목록에서 생긴 업무입니다. 이 업무로 보낸 글·지시·보고만 여기에 모입니다. 전체에서 보낸 글은 ‘전체’에 남습니다. ${send}`;
}

function decisionLinkText(d: Decision | undefined): string {
  if (!d) return "결재함에서 보기";
  if (d.status === "open") return "결재함에서 답하기";
  if (d.status === "closed") return "닫힌 결재 보기";
  const label = d.options.find((o) => o.k === d.choice)?.label ?? d.note;
  return label ? `답함: ${label}` : "답한 결재 보기";
}

function Jumps({ m, decision, file }: { m: Message; decision?: Decision; file?: FileDoc }) {
  if (!m.decisionId && !m.fileId) return null;
  return (
    <div className="th-jumps">
      {m.decisionId ? (
        <a className="th-link" data-open={decision?.status === "open" ? "" : undefined} href={routeHash({ projectId: m.projectId, tab: "inbox", sub: m.decisionId })}>
          <span className="th-link__text">{decisionLinkText(decision)}</span>
          <Chevron />
        </a>
      ) : null}
      {m.fileId ? (
        <a className="th-link" href={routeHash({ projectId: m.projectId, tab: "files", sub: m.fileId })}>
          <span className="th-link__text">자료 보기{file ? `: ${file.title}` : ""}</span>
          <Chevron />
        </a>
      ) : null}
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 연결이 없으면 다시 보내도 거부된다. 연결은 입력칸 자리에서 안내한다. */
function RetryButton({ m }: { m: Message }) {
  const gate = useGate();
  return (
    <button type="button" className="th-retry" disabled={!gate.ok} onClick={() => void resend(m)}>
      다시 보내기
    </button>
  );
}

/** 전체에서 글이 속한 업무. 누르면 그 업무의 글만 본다(입력칸의 업무도 같이 바뀐다. 받는 사람은 그대로). */
type OnTask = (taskId: string, messageId: string) => void;

function MineRow({ m, taskTitle, onTask }: { m: Message; taskTitle?: string; onTask?: OnTask }) {
  const delivery = deliveryLabel(m);
  const taskId = taskTitle ? m.taskId : null;
  return (
    <article className="th-row th-row--mine" data-mid={m.id}>
      <div className="th-mine">
        {m.targetName || taskId ? (
          <p className="th-mine__to">
            {m.targetName ? `${m.targetName}에게` : null}
            {m.targetName && taskId ? " · " : null}
            {taskId ? (
              <button type="button" className="th-mine__task" title={`업무 ${taskTitle}의 글만 보기`} onClick={() => onTask?.(taskId, m.id)}>
                업무 {taskTitle}
              </button>
            ) : null}
          </p>
        ) : null}
        {m.body ? <Markdown text={m.body} className="th-md" /> : null}
        <Attachments items={m.attachments} />
      </div>
      <p className="th-foot">
        <Time iso={m.at} />
        {delivery ? (
          <span className="th-delivery" data-tone={delivery.tone}>
            {delivery.text}
          </span>
        ) : null}
        {m.delivery === "failed" ? (
          <RetryButton m={m} />
        ) : null}
      </p>
    </article>
  );
}

function SystemRow({ m }: { m: Message }) {
  return (
    <article className="th-row th-row--system" data-mid={m.id}>
      <p className="th-system">
        {[m.title, m.body].filter(Boolean).join(" · ")} <Time iso={m.at} className="th-system__time" />
      </p>
    </article>
  );
}

/** 대표 차례 띠: 말풍선 맨 위. 글 끝의 '결재함 N건'은 오른쪽 링크가 된다. */
function OwnerBand({ m, action }: { m: Message; action: string }) {
  const { text, inbox } = splitOwnerAction(action);
  return (
    <div className="th-owner">
      <p className="th-owner__head">
        <span className="th-owner__label">대표 차례</span>
        {inbox ? (
          <a className="th-owner__inbox" href={routeHash({ projectId: m.projectId, tab: "inbox", sub: m.decisionId ?? null })}>
            {inbox}
            <Chevron />
          </a>
        ) : null}
      </p>
      <p className="th-owner__text">{text}</p>
    </div>
  );
}

function ReportRow({ m, decision, file, taskTitle, onTask }: { m: Message; decision?: Decision; file?: FileDoc; taskTitle?: string; onTask?: OnTask }) {
  const { action: ownerAction, rest: body } = splitOwnerLine(m.body);
  // 한 줄짜리 자동 보고는 제목이 곧 본문이다.
  const repeated = m.title.replace(/^\(자동\) /, "") === body.trim();
  return (
    <article className="th-row" data-mid={m.id}>
      <div className="th-card" data-owner={ownerAction === null ? undefined : ""}>
        {ownerAction === null ? null : <OwnerBand m={m} action={ownerAction} />}
        <header className="th-card__head">
          <Badge tone={kindTone(m.kind)}>{m.kind}</Badge>
          <span className="th-card__who">{m.who}</span>
          {taskTitle && m.taskId ? (
            <button type="button" className="th-card__task" title={`업무 ${taskTitle}의 글만 보기`} onClick={() => onTask?.(m.taskId!, m.id)}>
              <span className="th-card__task-text">{taskTitle}</span>
            </button>
          ) : null}
          <Time iso={m.at} className="th-card__time" />
        </header>
        {m.title ? <h3 className="th-card__title">{m.title}</h3> : null}
        {body.trim() && !repeated ? <Markdown text={body} className="th-md" /> : null}
        <Attachments items={m.attachments} />
        <Jumps m={m} decision={decision} file={file} />
      </div>
    </article>
  );
}

/** 결재 카드 사본: 한 줄로 결재함 카드를 가리킨다. 전체 글은 카드에 있다. */
function CardCopyRow({ m, decision }: { m: Message; decision?: Decision }) {
  return (
    <article className="th-row th-row--ask" data-mid={m.id}>
      <a className="th-ask" data-open={decision?.status === "open" ? "" : undefined} href={routeHash({ projectId: m.projectId, tab: "inbox", sub: m.decisionId })}>
        <span className="th-ask__text">
          {cardCopyText(m, decision)}
          <Time iso={m.at} className="th-ask__time" />
        </span>
      </a>
    </article>
  );
}

// 글 하나가 바뀌어도 나머지 마크다운을 다시 그리지 않는다(store 는 안 바뀐 글의 객체를 그대로 둔다)
// taskTitle 은 '전체'에서만 준다. 작업을 골라 보는 중에는 모든 글이 그 작업이라 표시하지 않는다.
// 작업 목록에 없는 task_id(지운 작업 등)는 이름을 모르므로 표지를 달지 않는다. 작업이 없는 옛 글(task_id 없음)도 추측해 달지 않는다.
const Row = memo(function Row({ m, decision, file, taskTitle, onTask }: { m: Message; decision?: Decision; file?: FileDoc; taskTitle?: string; onTask?: OnTask }) {
  if (m.mine) return <MineRow m={m} taskTitle={taskTitle} onTask={onTask} />;
  if (m.kind === "시스템") return <SystemRow m={m} />;
  if (isCardCopy(m)) return <CardCopyRow m={m} decision={decision} />;
  return <ReportRow m={m} decision={decision} file={file} taskTitle={taskTitle} onTask={onTask} />;
});

/** 총괄의 과정 글(맡김, 다시 알림)을 접은 한 줄. 누르면 펼친다. */
function FoldRow({ item, open, onToggle }: { item: Extract<ThreadItem, { type: "fold" }>; open: boolean; onToggle: () => void }) {
  const last = item.messages[item.messages.length - 1];
  return (
    <div className="th-row th-row--fold">
      <button type="button" className="th-fold" aria-expanded={open} onClick={onToggle}>
        <span className="th-fold__label">
          {foldLabel(item)} ({open ? "펼침" : "접힘"})
        </span>
        {foldPreview(item) ? <span className="th-fold__preview">{foldPreview(item)}</span> : null}
        <Time iso={last?.at} className="th-fold__time" />
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

/** 명부의 직원 종류. 상태가 바뀔 때마다 접기를 다시 셈하지 않게 id·종류가 같으면 같은 함수를 쓴다. */
function useKindOf(members: readonly Member[] | undefined): KindOf {
  const key = (members ?? []).map((m) => `${m.id}:${m.kind}`).join("|");
  return useMemo(() => {
    const kinds = new Map(key ? key.split("|").map((pair) => pair.split(":") as [string, Member["kind"]]) : []);
    return (id: string | null) => (id ? kinds.get(id) : undefined);
  }, [key]);
}

export default function Thread() {
  const [flowOpen, setFlowOpen] = useState(false);
  const project = useProject();
  const projectHasOlder = useStore((s) => s.hasOlderMessages);
  const projectId = project?.project.id ?? "";
  const { draft } = useSubmissionDraft(projectId);
  const tasks = project?.tasks ?? [];
  const task = draft.taskId ? tasks.find((t) => t.id === draft.taskId) ?? null : null;
  const taskTitles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks]);
  const history = useTaskHistory(projectId, task?.id ?? null);
  // 질문·선택·승인 창 앞에서 멈춘 직원. 작업 칩과 상관없이 늘 보인다(카드가 자기 작업을 적는다).
  // 답한 뒤 막힘이 풀려도 결과 줄(답함·이미 답함·실패)을 잠시 더 보인다.
  const recentAnswers = useRecentAnswers();
  const waiting = useMemo(() => (project?.members ?? []).filter((m) => m.origin !== "manual" && (m.status === "blocked" || recentAnswers.has(m.id))), [project?.members, recentAnswers]);
  const allMessages = project?.messages;
  const messages = useMemo(() => {
    const all = allMessages ?? [];
    if (!task) return all;
    return mergeHistoryMessages(history.items, all.filter((m) => m.taskId === task.id));
  }, [allMessages, task, history.items]);
  const hasOlder = task ? history.hasOlder : projectHasOlder;
  const decisions = useMemo(() => new Map(project?.decisions.map((d) => [d.id, d])), [project?.decisions]);
  const files = useMemo(() => new Map(project?.files.map((f) => [f.id, f])), [project?.files]);
  const kindOf = useKindOf(project?.members);
  const items = useMemo(() => foldThread(messages, kindOf), [messages, kindOf]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFold = (id: string) =>
    setUnfolded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // 작업 표지를 누르면 입력칸의 작업 칩과 같은 길로 고른다. 누른 글은 작업 화면에서도 보이게 그 자리로 옮긴다.
  const focus = useRef<{ taskId: string; messageId: string } | null>(null);
  const pickRef = useRef<OnTask>(() => {});
  pickRef.current = (taskId, messageId) => {
    const next = tasks.find((t) => t.id === taskId);
    if (!next) return;
    focus.current = { taskId, messageId };
    chooseTask(projectId, next);
  };
  const onTask = useCallback<OnTask>((taskId, messageId) => pickRef.current(taskId, messageId), []);
  const row = (m: Message) => (
    <Row key={m.id} m={m} decision={m.decisionId ? decisions.get(m.decisionId) : undefined} file={m.fileId ? files.get(m.fileId) : undefined}
      taskTitle={!task && m.taskId ? taskTitles.get(m.taskId) : undefined} onTask={onTask} />
  );

  const anchorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);
  const seenLast = useRef<string | null>(null);
  const seenTask = useRef<string | null>(null);
  const restoreFromBottom = useRef<number | null>(null);
  const loading = useRef(false);

  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  const pin = () => {
    const root = rootRef.current;
    if (!root) return;
    root.scrollTop = root.scrollHeight;
    lastTop.current = root.scrollTop;
    pinned.current = true;
    setAtBottom(true);
    setUnread(0);
  };

  const loadOlder = async () => {
    const root = rootRef.current;
    if (!root || loading.current) return;
    loading.current = true;
    setOlderBusy(true);
    setOlderError(null);
    const before = getState().project?.messages;
    // 위에 글이 붙어도 보던 자리는 바닥에서의 거리로 지킨다(Safari 에는 스크롤 앵커가 없다)
    restoreFromBottom.current = root.scrollHeight - root.scrollTop;
    const beforeTask = history.items;
    try {
      if (task) await history.loadOlder();
      else await loadOlderMessages();
    } catch (e) {
      setOlderError(errorText(e));
    } finally {
      if (task ? history.items === beforeTask : getState().project?.messages === before) restoreFromBottom.current = null;
      loading.current = false;
      setOlderBusy(false);
    }
  };
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  const canAutoLoad = useRef(false);
  canAutoLoad.current = hasOlder && !olderError && !(task && history.busy);

  // 글이 바뀔 때: 그리고 나서 칠하기 전에 자리를 잡는다
  useLayoutEffect(() => {
    const root = rootRef.current ?? anchorRef.current?.closest<HTMLElement>("[data-scroll-root]") ?? null;
    rootRef.current = root;
    if (!root) return;
    // 작업을 바꾸면 다른 대화다. 맨 아래로 가고 새 글 수를 세지 않는다.
    if (seenTask.current !== (task?.id ?? null)) {
      seenTask.current = task?.id ?? null;
      seenLast.current = null;
      restoreFromBottom.current = null;
      setOlderError(null);
    }
    const last = messages[messages.length - 1];
    const prevLast = seenLast.current;
    seenLast.current = last?.id ?? null;

    if (restoreFromBottom.current !== null) {
      root.scrollTop = root.scrollHeight - restoreFromBottom.current;
      lastTop.current = root.scrollTop;
      restoreFromBottom.current = null;
    }
    if (!last || last.id === prevLast) return;
    // 내가 보낸 글은 어디를 보고 있었든 따라간다
    if (prevLast === null || pinned.current || last.mine) {
      pin();
      return;
    }
    const seenAt = messages.findIndex((x) => x.id === prevLast);
    setUnread((n) => n + (seenAt < 0 ? 1 : messages.length - 1 - seenAt));
  }, [messages]);

  // 작업 표지로 옮겨 왔으면 맨 아래 대신 누른 글을 보인다. 작업의 이전 글이 위에 붙는 동안(불러오는 중)에도 그 글을 지킨다.
  useLayoutEffect(() => {
    const target = focus.current;
    const root = rootRef.current;
    if (!target || !root) return;
    if (task?.id !== target.taskId) {
      if (draft.taskId !== target.taskId) focus.current = null;
      return;
    }
    const fold = items.find((it): it is Extract<ThreadItem, { type: "fold" }> => it.type === "fold" && it.messages.some((x) => x.id === target.messageId));
    if (fold && !unfolded.has(fold.id)) {
      setUnfolded((s) => new Set(s).add(fold.id));
      return;
    }
    const el = anchorRef.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(target.messageId)}"]`);
    if (el) {
      root.scrollTop = Math.max(0, el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - root.clientHeight / 4);
      lastTop.current = root.scrollTop;
      pinned.current = distanceFromBottom(root) < PIN_DISTANCE;
      setAtBottom(pinned.current);
      if (!el.hasAttribute("data-flash")) {
        el.setAttribute("data-flash", "");
        el.tabIndex = -1;
        el.focus({ preventScroll: true });
        window.setTimeout(() => el.removeAttribute("data-flash"), 1600);
      }
    }
    if (!history.busy) focus.current = null;
  }, [messages, items, unfolded, task?.id, draft.taskId, history.busy]);

  useEffect(() => {
    const root = rootRef.current;
    const list = anchorRef.current;
    if (!root || !list) return;
    const onScroll = () => {
      const top = root.scrollTop;
      const near = distanceFromBottom(root) < PIN_DISTANCE;
      // 글이 늘어 거리가 벌어진 것과 사용자가 올린 것을 가른다: 위로 움직였을 때만 바닥에서 떨어진다
      if (near) pinned.current = true;
      else if (top < lastTop.current) pinned.current = false;
      lastTop.current = top;
      setAtBottom(pinned.current);
      if (near) setUnread(0);
      if (top < LOAD_OLDER_DISTANCE && canAutoLoad.current) void loadOlderRef.current();
    };
    // 글·입력칸·키보드로 높이가 변해도 바닥에 있었다면 바닥을 지킨다. 입력칸 높이는 Shell 의 관찰자가 root 의 padding 으로 옮기므로
    // root 를 직접 보면 관찰 루프가 생긴다(ResizeObserver loop 오류). 원인 쪽을 보고, 옮겨진 뒤인 다음 프레임에 맞춘다.
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (pinned.current) root.scrollTop = root.scrollHeight;
      });
    });
    ro.observe(list);
    for (const el of [root.closest(".shell"), root.parentElement?.querySelector(".shell__bottom")]) if (el) ro.observe(el);
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      root.removeEventListener("scroll", onScroll);
    };
  }, []);

  const hqLead = project?.project.isHq ? project.members.find((m) => m.kind === "root") : null;
  return (
    <div ref={anchorRef} className="th">
      {hqLead ? <HqLeadStrip lead={hqLead} /> : null}
      {task ? <TaskBar task={task} expanded={flowOpen} onFlow={() => setFlowOpen((open) => !open)} /> : null}
      {project && task && flowOpen ? <WorkFlow key={projectId} state={project} selectedTaskId={task.id} /> : null}
      {task && history.error && messages.length === 0 ? <p className="th-older__error">{history.error}</p> : null}
      {messages.length === 0 ? (
        task ? (
          history.busy ? (
            <Empty title="불러오는 중">이 업무의 대화를 불러오고 있습니다.</Empty>
          ) : (
            <Empty title="이 업무의 대화가 아직 없습니다">{emptyTaskText(task, project?.members ?? [], draft.targetId)}</Empty>
          )
        ) : (
          <Empty title="아직 대화가 없습니다">아래 입력칸에 지시를 적으면 여기에 이어집니다.</Empty>
        )
      ) : (
        <>
          {hasOlder ? (
            <div className="th-older">
              {olderError ? <p className="th-older__error">{olderError}</p> : null}
              <GlassButton variant="ghost" size="s" disabled={olderBusy} onClick={() => void loadOlder()}>
                {olderBusy ? "불러오는 중" : olderError ? "다시 불러오기" : "이전 글 불러오기"}
              </GlassButton>
            </div>
          ) : null}
          <div className="th-list" role="log" aria-label={task ? `대화: 업무 ${task.title}` : "대화"}>
            {items.map((item) =>
              item.type === "message" ? (
                row(item.message)
              ) : (
                <Fragment key={item.id}>
                  <FoldRow item={item} open={unfolded.has(item.id)} onToggle={() => toggleFold(item.id)} />
                  {unfolded.has(item.id) ? item.messages.map(row) : null}
                </Fragment>
              ),
            )}
          </div>
        </>
      )}
      {waiting.length ? (
        <div className="th-waits" aria-label="답을 기다리는 직원">
          {waiting.map((m) => <NativePromptCard key={m.id} member={m} tasks={tasks} />)}
        </div>
      ) : null}
      {atBottom ? null : (
        <div className="th-down">
          <GlassButton variant={unread > 0 ? "primary" : "glass"} size="s" onClick={pin}>
            {unread > 0 ? `새 글 ${unread}개` : "맨 아래로"}
          </GlassButton>
        </div>
      )}
    </div>
  );
}
