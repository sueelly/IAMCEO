// Agent-A 정본 문서를 자료 곁에서 읽고, 댓글로 묻거나 고쳐 달라고 하고, 수정안을 골라 반영한다(체험판).
// 정본·판·수정안 검증은 Agent-A 서버가 한다. 이 화면은 서버가 방금 읽은 정본만 그린다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentABlock, AgentADocView, AgentAExecutor, AgentAOpResult, AgentAProposal, AgentARequest, AgentARequestState } from "@shared/agent-a";
import { api, errorText } from "../lib/api";
import { Markdown, Time } from "./ui";
import "../styles/agent-a.css";

const OPEN: AgentARequestState[] = ["sending", "unconfirmed", "queued", "running", "waiting_staff", "stop_requested"];

const STATE_LABEL: Record<AgentARequestState, string> = {
  sending: "보내는 중",
  unconfirmed: "응답 확인 중",
  queued: "접수됨",
  running: "답 쓰는 중",
  waiting_staff: "직원에게 맡김",
  answered: "답 옴",
  failed: "끝나지 않음",
  unknown: "결과 미확인",
  stop_requested: "멈춤 요청함",
};

const PROPOSAL_LABEL: Record<AgentAProposal["status"], string> = {
  pending: "검토할 수정안",
  held: "보류한 수정안",
  rejected: "거절함",
  applied: "반영함",
  conflict: "충돌",
};

function newOpId(): string {
  return `op-${crypto.randomUUID()}`;
}

/** 낱말 단위 비교. 문서 블록 하나 정도의 길이만 다룬다. */
export function wordDiff(before: string, after: string): { kind: "same" | "del" | "ins"; text: string }[] {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  if (a.length * b.length > 4_000_000) return [{ kind: "del", text: before }, { kind: "ins", text: after }];
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { kind: "same" | "del" | "ins"; text: string }[] = [];
  const push = (kind: "same" | "del" | "ins", text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("same", a[i]!); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { push("del", a[i]!); i++; }
    else { push("ins", b[j]!); j++; }
  }
  while (i < n) push("del", a[i++]!);
  while (j < m) push("ins", b[j++]!);
  return out;
}

function Diff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => wordDiff(before, after), [before, after]);
  return (
    <div className="aa-diff" aria-label="바뀐 곳">
      {parts.map((p, i) => (p.kind === "same" ? <span key={i}>{p.text}</span> : p.kind === "del" ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>))}
    </div>
  );
}

function executorLabel(r: Pick<AgentARequest, "executor" | "assigneeName">): string {
  return r.executor === "agent_a" ? "Agent-A 자체 AI" : `직원 ${r.assigneeName ?? "(담당 없음)"}`;
}

interface Props {
  fileId: string;
  projectId: string;
  focus: string | null;
  staff: { id: string; name: string }[];
}

export function AgentADoc({ fileId, projectId, focus, staff }: Props) {
  const [view, setView] = useState<AgentADocView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composer, setComposer] = useState<{ blockId: string; blockRevision: number; quote: string | null; supersedesId: string | null; text: string } | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const opRef = useRef<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const pollStarted = useRef<number>(0);

  const load = useCallback(async () => {
    try {
      const v = await api.agentADoc(fileId);
      setView(v);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [fileId]);

  useEffect(() => {
    setView(null);
    setComposer(null);
    void load();
  }, [load]);

  const pending = view?.requests.some((r) => OPEN.includes(r.state)) ?? false;

  // 답을 기다리는 동안만 다시 읽는다. 3초 → 10초 → 30초. 탭을 숨기면 멈추고 돌아오면 바로 읽는다.
  useEffect(() => {
    if (!pending) {
      pollStarted.current = 0;
      return;
    }
    if (!pollStarted.current) pollStarted.current = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const delay = () => {
      const elapsed = Date.now() - pollStarted.current;
      return elapsed < 60_000 ? 3_000 : elapsed < 300_000 ? 10_000 : 30_000;
    };
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void load().finally(() => {
        timer = setTimeout(tick, delay());
      });
    };
    timer = setTimeout(tick, delay());
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pending, load]);

  // 알림에서 온 원래 댓글로 옮기고, 읽음으로 남긴다.
  useEffect(() => {
    if (!focus || !view) return;
    const el = document.querySelector<HTMLElement>(`[data-aa-request="${CSS.escape(focus)}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, view?.readAt]);

  useEffect(() => {
    if (!view) return;
    for (const r of view.requests) if (!r.seen && !OPEN.includes(r.state) && (r.id === focus || r.parentId === null)) void api.agentASeen(r.id).catch(() => {});
  }, [view, focus]);

  const startComment = (block: AgentABlock, supersedes: AgentARequest | null = null) => {
    const sel = window.getSelection();
    let quote: string | null = null;
    const host = document.querySelector(`[data-aa-block="${CSS.escape(block.id)}"]`);
    if (sel && !sel.isCollapsed && host && sel.anchorNode && host.contains(sel.anchorNode)) quote = sel.toString().trim().slice(0, 500) || null;
    opRef.current = newOpId();
    setSendError(null);
    setComposer({ blockId: block.id, blockRevision: block.revision, quote: supersedes?.quote ?? quote, supersedesId: supersedes?.id ?? null, text: supersedes?.text ?? "" });
  };

  const send = async () => {
    if (!composer || !composer.text.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      // 응답을 못 받아 다시 눌러도 같은 opId 라 서버가 한 번만 만든다.
      await api.agentARequest(fileId, { opId: opRef.current!, blockId: composer.blockId, blockRevision: composer.blockRevision, quote: composer.quote, text: composer.text, supersedesId: composer.supersedesId });
      setComposer(null);
      opRef.current = null;
      await load();
    } catch (e) {
      setSendError(errorText(e));
      if (String(errorText(e)).includes("최신본")) await load();
    } finally {
      setSending(false);
    }
  };

  if (loadError && !view) return <p className="aa-error" role="alert">{loadError}</p>;
  if (!view) return <p className="aa-muted">Agent-A 정본을 읽는 중입니다</p>;

  const roots = view.requests.filter((r) => r.parentId === null);
  const childrenOf = (id: string) => view.requests.filter((r) => r.parentId === id);
  const byBlock = (blockId: string) => roots.filter((r) => r.blockId === blockId);

  return (
    <div className="aa">
      <div className="aa-bar">
        <span className="aa-src">Agent-A 정본 · 판 {view.artifactRevision}</span>
        <span className="aa-muted">
          방금 읽음 <Time iso={view.readAt} />
        </span>
        <ExecutorPicker view={view} staff={staff} onChange={setView} />
      </div>
      {loadError ? <p className="aa-error" role="alert">{loadError} · 마지막으로 읽은 정본을 보여 줍니다</p> : null}

      <div className="aa-cols">
        <div className="aa-doc">
          {view.blocks.filter((b) => !b.archived).map((b) => (
            <section key={b.id} className="aa-block" data-aa-block={b.id}>
              <header className="aa-block__head">
                <h3>{b.title}</h3>
                <span className="aa-tag">문단 판 {b.revision}</span>
                {b.history.length ? (
                  <button type="button" className="aa-link" onClick={() => setHistoryOf(historyOf === b.id ? null : b.id)}>
                    {historyOf === b.id ? "예전 판 닫기" : `예전 판 ${b.history.length}개`}
                  </button>
                ) : null}
              </header>
              <Markdown text={b.body} className="aa-block__body" />
              {historyOf === b.id ? (
                <div className="aa-history">
                  {[...b.history].reverse().map((h) => (
                    <div key={h.revision} className="aa-history__item">
                      <span className="aa-tag">판 {h.revision}</span>
                      <Markdown text={h.body} />
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="aa-block__foot">
                <button type="button" className="aa-btn" onClick={() => startComment(b)}>
                  댓글
                </button>
                {byBlock(b.id).length ? <span className="aa-muted">댓글 {byBlock(b.id).length}</span> : null}
              </div>
              {composer?.blockId === b.id ? (
                <div className="aa-composer">
                  {composer.quote ? <blockquote className="aa-quote">{composer.quote}</blockquote> : <p className="aa-muted">문단 전체에 답니다. 문장을 고르고 '댓글'을 누르면 그 문장에 답니다.</p>}
                  {composer.supersedesId ? <p className="aa-muted">최신본(문단 판 {composer.blockRevision}) 기준으로 다시 요청합니다. 원래 댓글은 그대로 남습니다.</p> : null}
                  <textarea
                    aria-label="댓글"
                    rows={3}
                    value={composer.text}
                    placeholder="묻거나 고쳐 달라고 쓰세요"
                    onChange={(e) => setComposer({ ...composer, text: e.target.value })}
                  />
                  {sendError ? <p className="aa-error" role="alert">{sendError}</p> : null}
                  <div className="aa-row">
                    <button type="button" className="aa-btn aa-btn--primary" disabled={sending || !composer.text.trim()} onClick={() => void send()}>
                      {sending ? "보내는 중" : "보내기"}
                    </button>
                    <button type="button" className="aa-btn" onClick={() => setComposer(null)}>
                      취소
                    </button>
                    <span className="aa-muted">답할 곳: {view.executor === "agent_a" ? "Agent-A 자체 AI" : `직원 ${staff.find((s) => s.id === view.assigneeId)?.name ?? ""}`}</span>
                  </div>
                </div>
              ) : null}
            </section>
          ))}
          <Versions view={view} />
        </div>

        <aside className="aa-threads" aria-label="댓글">
          {roots.length === 0 ? <p className="aa-muted">아직 댓글이 없습니다. 문단의 '댓글'로 묻거나 고쳐 달라고 하세요.</p> : null}
          {[...roots].reverse().map((r) => (
            <Thread
              key={r.id}
              root={r}
              replies={childrenOf(r.id)}
              view={view}
              focused={focus === r.id || childrenOf(r.id).some((c) => c.id === focus)}
              staff={staff}
              projectId={projectId}
              reload={load}
              onRetryLatest={(req) => {
                const block = view.blocks.find((x) => x.id === req.blockId);
                if (block) startComment(block, req);
              }}
            />
          ))}
        </aside>
      </div>
    </div>
  );
}

function ExecutorPicker({ view, staff, onChange }: { view: AgentADocView; staff: { id: string; name: string }[]; onChange: (v: AgentADocView) => void }) {
  const [error, setError] = useState<string | null>(null);
  const value = view.executor === "agent_a" ? "agent_a" : `staff:${view.assigneeId ?? ""}`;
  return (
    <label className="aa-picker">
      <span>새 요청에 답할 곳</span>
      <select
        value={value}
        onChange={async (e) => {
          const v = e.target.value;
          const executor: AgentAExecutor = v === "agent_a" ? "agent_a" : "staff";
          try {
            onChange(await api.agentASetExecutor(view.fileId, executor, executor === "staff" ? v.slice(6) : null));
            setError(null);
          } catch (err) {
            setError(errorText(err));
          }
        }}
      >
        <option value="agent_a">Agent-A 자체 AI</option>
        {staff.map((s) => (
          <option key={s.id} value={`staff:${s.id}`}>
            IAMCEO 직원 {s.name}
          </option>
        ))}
      </select>
      {error ? <span className="aa-error">{error}</span> : null}
    </label>
  );
}

function Versions({ view }: { view: AgentADocView }) {
  return (
    <section className="aa-versions" aria-label="정본 판">
      <h4>정본 판</h4>
      <ol>
        {[...view.versions].reverse().map((v) => (
          <li key={`${v.revision}-${v.at}`}>
            <span className="aa-tag">판 {v.revision}</span> {v.cause} · <Time iso={v.at} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Thread({
  root,
  replies,
  view,
  focused,
  staff,
  projectId,
  reload,
  onRetryLatest,
}: {
  root: AgentARequest;
  replies: AgentARequest[];
  view: AgentADocView;
  focused: boolean;
  staff: { id: string; name: string }[];
  projectId: string;
  reload: () => Promise<void>;
  onRetryLatest: (r: AgentARequest) => void;
}) {
  const block = view.blocks.find((b) => b.id === root.blockId);
  const original = block && block.revision !== root.blockRevision ? block.history.find((h) => h.revision === root.blockRevision) : null;
  const [showOriginal, setShowOriginal] = useState(false);
  const [reply, setReply] = useState("");
  const replyOp = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = [root, ...replies];
  const last = all[all.length - 1]!;
  const open = all.some((r) => OPEN.includes(r.state));

  const sendReply = async () => {
    if (!reply.trim() || busy) return;
    replyOp.current ??= newOpId();
    setBusy(true);
    setError(null);
    try {
      await api.agentAReply(root.id, replyOp.current, reply);
      setReply("");
      replyOp.current = null;
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="aa-thread" data-aa-request={root.id} data-focused={focused ? "" : undefined} id={`aa-${root.id}`}>
      <header className="aa-thread__head">
        <span className="aa-muted">
          '{block?.title ?? root.blockId}' · 문단 판 {root.blockRevision} · 정본 판 {root.baseArtifactRevision}
        </span>
        {root.supersedesId ? <span className="aa-tag">최신본 기준 재요청</span> : null}
      </header>
      {root.quote ? <blockquote className="aa-quote">{root.quote}</blockquote> : null}
      {original ? (
        <div className="aa-original">
          <p className="aa-muted">이 댓글은 문단 판 {root.blockRevision}에 달렸습니다. 지금 이 문단은 판 {block!.revision}입니다.</p>
          <button type="button" className="aa-link" onClick={() => setShowOriginal(!showOriginal)}>
            {showOriginal ? "원문 닫기" : "이 댓글의 원문 보기"}
          </button>
          {showOriginal ? <Markdown text={original.body} className="aa-original__body" /> : null}
        </div>
      ) : null}
      {all.map((r) => (
        <RequestItem key={r.id} r={r} view={view} staff={staff} projectId={projectId} reload={reload} onRetryLatest={onRetryLatest} focused={focused} />
      ))}
      {!open && last.state !== "sending" ? (
        <div className="aa-reply">
          <textarea aria-label="답글" rows={2} value={reply} placeholder="이어서 묻기" onChange={(e) => setReply(e.target.value)} />
          {error ? <p className="aa-error" role="alert">{error}</p> : null}
          <button type="button" className="aa-btn" disabled={busy || !reply.trim()} onClick={() => void sendReply()}>
            {busy ? "보내는 중" : "답글 보내기"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function RequestItem({
  r,
  view,
  staff,
  reload,
  onRetryLatest,
}: {
  r: AgentARequest;
  view: AgentADocView;
  staff: { id: string; name: string }[];
  projectId: string;
  reload: () => Promise<void>;
  onRetryLatest: (r: AgentARequest) => void;
  focused: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setBusy(true);
    try {
      await api.agentAStop(r.id);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const assign = async (memberId: string) => {
    setBusy(true);
    try {
      await api.agentAAssign(r.id, memberId);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="aa-req" data-state={r.state}>
      <div className="aa-msg aa-msg--me">
        <p>{r.text}</p>
        <span className="aa-muted">
          <Time iso={r.createdAt} /> · {executorLabel(r)}
        </span>
      </div>
      <p className="aa-state" data-state={r.state}>
        <span className="aa-chip" data-state={r.state}>
          {r.state === "waiting_staff" ? `직원 ${r.assigneeName ?? ""}에게 맡김` : STATE_LABEL[r.state]}
        </span>
        {r.error && r.state !== "answered" ? <span className="aa-muted">{r.error}</span> : null}
        {r.executor === "agent_a" && (r.state === "running" || r.state === "queued") ? (
          <button type="button" className="aa-link" disabled={busy} onClick={() => void stop()}>
            멈추기
          </button>
        ) : null}
        {r.executor === "staff" && (r.state === "waiting_staff" || r.state === "queued") && staff.length > 1 ? (
          <select aria-label="담당 바꾸기" value="" disabled={busy} onChange={(e) => e.target.value && void assign(e.target.value)}>
            <option value="">담당 바꾸기</option>
            {staff.filter((s) => s.id !== r.assigneeId).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
      </p>
      {error ? <p className="aa-error" role="alert">{error}</p> : null}
      {r.answer ? (
        <div className="aa-msg aa-msg--ai">
          <span className="aa-who">{executorLabel(r)}</span>
          <Markdown text={r.answer.body} />
        </div>
      ) : null}
      {r.lateResults.map((l, i) => (
        <div key={i} className="aa-late">
          <span className="aa-tag">이전 담당 결과 · 반영 안 됨</span> {l.memberName}(담당 차례 {l.assignmentGen}) · <Time iso={l.at} />
          <Markdown text={l.answer} />
        </div>
      ))}
      {r.proposals.map((p) => (
        <Proposal key={p.id} p={p} r={r} view={view} reload={reload} onRetryLatest={onRetryLatest} />
      ))}
    </div>
  );
}

function Proposal({ p, r, view, reload, onRetryLatest }: { p: AgentAProposal; r: AgentARequest; view: AgentADocView; reload: () => Promise<void>; onRetryLatest: (r: AgentARequest) => void }) {
  const opRef = useRef<{ kind: "apply" | "reject"; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AgentAOpResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (kind: "apply" | "reject") => {
    if (busy) return;
    // 응답을 못 받아 다시 누르면 같은 opId 로 결과를 확인한다(두 번 반영하지 않는다).
    if (!opRef.current || opRef.current.kind !== kind || result?.state === "conflict" || result?.state === "failed") opRef.current = { kind, id: newOpId() };
    setBusy(true);
    setError(null);
    try {
      const res = kind === "apply" ? await api.agentAApply(view.fileId, p.id, opRef.current.id) : await api.agentAReject(view.fileId, p.id, opRef.current.id, "대표가 거절");
      setResult(res);
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const open = p.status === "pending" || p.status === "held";
  return (
    <div className="aa-prop" data-status={p.status}>
      <header className="aa-prop__head">
        <span className="aa-chip" data-status={p.status}>{PROPOSAL_LABEL[p.status]}</span>
        <span className="aa-muted">정본 판 {p.baseArtifactRevision} 기준</span>
      </header>
      {p.reason ? <p className="aa-prop__reason">{p.reason}</p> : null}
      {p.operations.map((op, i) => (
        <div key={i} className="aa-ba">
          <div>
            <span className="aa-muted">바꾸기 전 · 문단 판 {op.baseRevision}</span>
            <Markdown text={op.before ?? ""} />
          </div>
          <div>
            <span className="aa-muted">바꾼 뒤</span>
            <Markdown text={op.after ?? "(보관)"} />
          </div>
          {op.before !== null && op.after !== null ? (
            <div className="aa-ba__diff">
              <span className="aa-muted">바뀐 곳</span>
              <Diff before={op.before} after={op.after} />
            </div>
          ) : null}
        </div>
      ))}
      {open && p.staleReason ? (
        <p className="aa-warn" role="status">
          {p.staleReason}. 그대로 반영할 수 없습니다.{" "}
          <button type="button" className="aa-link" onClick={() => onRetryLatest(r)}>
            최신본 기준으로 다시 요청
          </button>
        </p>
      ) : null}
      {open ? (
        <div className="aa-row">
          <button type="button" className="aa-btn aa-btn--primary" disabled={busy || !p.applicable} onClick={() => void decide("apply")}>
            {busy && opRef.current?.kind === "apply" ? "반영하는 중" : "정본에 반영"}
          </button>
          <button type="button" className="aa-btn" disabled={busy} onClick={() => void decide("reject")}>
            거절
          </button>
        </div>
      ) : null}
      {result ? (
        <p className={result.state === "committed" ? "aa-ok" : "aa-warn"} role="status">
          {result.state === "committed"
            ? p.status === "rejected" || opRef.current?.kind === "reject"
              ? "거절을 정본에 남겼습니다."
              : result.verified
                ? `정본 판 ${result.artifactRevision}(으)로 반영했고, 정본을 다시 읽어 바뀐 본문을 확인했습니다.`
                : `정본 판 ${result.artifactRevision}에 저장됐지만 본문 확인이 맞지 않습니다.`
            : result.message}
          {result.state === "conflict" ? (
            <>
              {" "}
              <button type="button" className="aa-link" onClick={() => onRetryLatest(r)}>
                최신본 기준으로 다시 요청
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {error ? <p className="aa-error" role="alert">{error}</p> : null}
    </div>
  );
}
