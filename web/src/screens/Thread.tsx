// 대화: 보고와 내 말을 시간순으로. 본문 스크롤은 Shell 의 data-scroll-root 가 맡는다.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Decision, FileDoc, Message, MessageKind, Task } from "@shared/types";
import { GlassButton } from "../glass";
import { api, errorText } from "../lib/api";
import { mergeHistoryMessages } from "../lib/history";
import { useSubmissionDraft } from "../lib/submission-client";
import { getState, loadOlderMessages, routeHash, sendMessage, useProject, useStore } from "../lib/store";
import { Attachments } from "../components/Attachments";
import { Badge, Empty, Markdown, Time, type BadgeTone } from "../components/ui";
import { useGate } from "../components/ConnectGate";
import { HqLeadStrip } from "./Inbox";
import "../styles/thread.css";

const PIN_DISTANCE = 80;
const LOAD_OLDER_DISTANCE = 480;

const KIND_TONE: Partial<Record<MessageKind, BadgeTone>> = { 완료: "ok", 질문: "accent", 막힘: "danger" };

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

const TASK_PAGE = 200;

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

function TaskBar({ task }: { task: Task }) {
  return (
    <div className="th-task" role="note">
      <span className="th-task__label">작업</span>
      <span className="th-task__title">{task.title}</span>
      <span className="th-task__meta">{[task.who, task.branch, task.worktree].filter(Boolean).join(" · ")}</span>
    </div>
  );
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

function MineRow({ m, taskTitle }: { m: Message; taskTitle?: string }) {
  const delivery = deliveryLabel(m);
  const to = [m.targetName ? `${m.targetName}에게` : null, taskTitle ? `작업 ${taskTitle}` : null].filter(Boolean).join(" · ");
  return (
    <article className="th-row th-row--mine">
      <div className="th-mine">
        {to ? <p className="th-mine__to">{to}</p> : null}
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
    <article className="th-row th-row--system">
      <p className="th-system">
        {[m.title, m.body].filter(Boolean).join(" · ")} <Time iso={m.at} className="th-system__time" />
      </p>
    </article>
  );
}

function ReportRow({ m, decision, file, taskTitle }: { m: Message; decision?: Decision; file?: FileDoc; taskTitle?: string }) {
  // 한 줄짜리 자동 보고는 제목이 곧 본문이다.
  const repeated = m.title.replace(/^\(자동\) /, "") === m.body.trim();
  return (
    <article className="th-row">
      <div className="th-card">
        <header className="th-card__head">
          <Badge tone={KIND_TONE[m.kind] ?? "neutral"}>{m.kind}</Badge>
          <span className="th-card__who">{m.who}</span>
          {taskTitle ? <span className="th-card__task" title={`작업 ${taskTitle}`}>{taskTitle}</span> : null}
          <Time iso={m.at} className="th-card__time" />
        </header>
        {m.title ? <h3 className="th-card__title">{m.title}</h3> : null}
        {m.body && !repeated ? <Markdown text={m.body} className="th-md" /> : null}
        <Attachments items={m.attachments} />
        <Jumps m={m} decision={decision} file={file} />
      </div>
    </article>
  );
}

// 글 하나가 바뀌어도 나머지 마크다운을 다시 그리지 않는다(store 는 안 바뀐 글의 객체를 그대로 둔다)
// taskTitle 은 '전체'에서만 준다. 작업을 골라 보는 중에는 모든 글이 그 작업이라 표시하지 않는다.
const Row = memo(function Row({ m, decision, file, taskTitle }: { m: Message; decision?: Decision; file?: FileDoc; taskTitle?: string }) {
  if (m.mine) return <MineRow m={m} taskTitle={taskTitle} />;
  if (m.kind === "시스템") return <SystemRow m={m} />;
  return <ReportRow m={m} decision={decision} file={file} taskTitle={taskTitle} />;
});

export default function Thread() {
  const project = useProject();
  const projectHasOlder = useStore((s) => s.hasOlderMessages);
  const projectId = project?.project.id ?? "";
  const { draft } = useSubmissionDraft(projectId);
  const tasks = project?.tasks ?? [];
  const task = draft.taskId ? tasks.find((t) => t.id === draft.taskId) ?? null : null;
  const taskTitles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks]);
  const history = useTaskHistory(projectId, task?.id ?? null);
  const allMessages = project?.messages;
  const messages = useMemo(() => {
    const all = allMessages ?? [];
    if (!task) return all;
    return mergeHistoryMessages(history.items, all.filter((m) => m.taskId === task.id));
  }, [allMessages, task, history.items]);
  const hasOlder = task ? history.hasOlder : projectHasOlder;
  const decisions = useMemo(() => new Map(project?.decisions.map((d) => [d.id, d])), [project?.decisions]);
  const files = useMemo(() => new Map(project?.files.map((f) => [f.id, f])), [project?.files]);

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
      {task ? <TaskBar task={task} /> : null}
      {task && history.error && messages.length === 0 ? <p className="th-older__error">{history.error}</p> : null}
      {messages.length === 0 ? (
        task ? (
          history.busy ? (
            <Empty title="불러오는 중">이 작업의 대화를 불러오고 있습니다.</Empty>
          ) : (
            <Empty title="이 작업의 대화가 아직 없습니다">아래 입력칸에 적으면 이 작업으로 {task.who}에게 갑니다. 전체 대화는 입력칸 위 ‘전체’에서 봅니다.</Empty>
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
          <div className="th-list" role="log" aria-label={task ? `대화: 작업 ${task.title}` : "대화"}>
            {messages.map((m) => (
              <Row key={m.id} m={m} decision={m.decisionId ? decisions.get(m.decisionId) : undefined} file={m.fileId ? files.get(m.fileId) : undefined}
                taskTitle={!task && m.taskId ? taskTitles.get(m.taskId) : undefined} />
            ))}
          </div>
        </>
      )}
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
