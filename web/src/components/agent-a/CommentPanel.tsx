// Agent-A 댓글 칸: 내 차례 · 댓글 목록 · 댓글 하나(대화·수정안·답글) · 새 댓글 쓰기. IAMCEO 공통 버튼·배지·마크다운을 쓴다.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AgentAReviewAnnotation, AgentAReviewImageRegion, AgentAReviewProposal } from "@shared/agent-a";
import { GlassButton } from "../../glass";
import { PROPOSAL_LABEL, kindLabel, oneLine, wordDiff, type ReviewThread, type TurnItem } from "../../lib/agent-a-review";
import { enterSends, isComposing, useAutoGrow } from "../Composer";
import { Badge, Markdown, useConfirmPress } from "../ui";

export type PanelView =
  | { kind: "list" }
  | { kind: "thread"; id: string }
  | { kind: "new"; target: { kind: "quote"; quote: string } | { kind: "global" } | { kind: "region"; region: AgentAReviewImageRegion } };

/** 글 쓰는 칸. Enter 로 보낸다(터치 기기는 단추). 보내는 동안 다시 눌리지 않는다. */
function Compose({ label, placeholder, value, onChange, onSend, busy, send = "보내기", autoFocus }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; onSend: () => void; busy: boolean; send?: string; autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, value);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(e) || !enterSends(e)) return;
    e.preventDefault();
    if (!busy && value.trim()) onSend();
  };
  return (
    <div className="aar-compose">
      <textarea ref={ref} className="aar-compose__input" aria-label={label} placeholder={placeholder} rows={2} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} />
      <GlassButton variant="primary" size="s" disabled={busy || !value.trim()} onClick={onSend}>
        {busy ? "보내는 중" : send}
      </GlassButton>
    </div>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const parts = wordDiff(before, after);
  return (
    <p className="aar-diff">
      {parts.map((p, i) => (p.kind === "add" ? <ins key={i}>{p.text}</ins> : p.kind === "del" ? <del key={i}>{p.text}</del> : <span key={i}>{p.text}</span>))}
    </p>
  );
}

/** 수정안 하나: 고친 뒤 본문, 전후 비교, 정본에 저장. 다른 수정안은 건드리지 않는다. */
export function ProposalCard({ proposal, busy, onApprove, actions }: { proposal: Pick<AgentAReviewProposal, "status" | "reason" | "operations"> & { current?: boolean; staleReason?: string | null }; busy: boolean; onApprove?: () => void; actions?: ReactNode }) {
  const open = proposal.status === "pending" || proposal.status === "held";
  return (
    <section className="aar-proposal" data-state={proposal.status} aria-label="문서 수정안">
      <header className="aar-proposal__head">
        <strong>문서 수정안</strong>
        <Badge tone={proposal.status === "applied" ? "ok" : proposal.status === "conflict" ? "danger" : proposal.status === "rejected" ? "neutral" : "accent"}>
          {proposal.status === "applied" && proposal.current === false ? "저장 뒤 다시 바뀜" : PROPOSAL_LABEL[proposal.status]}
        </Badge>
      </header>
      {proposal.reason ? <p className="aar-proposal__reason">{proposal.reason}</p> : null}
      {proposal.operations.map((op, i) => (
        <div key={i} className="aar-proposal__op">
          <p className="aar-proposal__title">{op.op === "archive" ? `보관: ${op.title}` : op.op === "insert" ? `새 블록: ${op.title}` : op.title}</p>
          {op.op === "archive" ? <p className="aar-diff"><del>{op.before ?? ""}</del></p> : <p className="aar-proposal__after">{op.after ?? ""}</p>}
          {op.op !== "archive" && op.before !== null && op.after !== null ? (
            <details className="aar-proposal__compare">
              <summary>변경 비교</summary>
              <Diff before={op.before} after={op.after} />
            </details>
          ) : null}
        </div>
      ))}
      {proposal.staleReason ? <p className="aar-note" role="status">{proposal.staleReason}</p> : null}
      {open && (onApprove || actions) ? (
        <footer className="aar-proposal__foot">
          {onApprove ? (
            <GlassButton variant="primary" size="s" disabled={busy} onClick={onApprove}>
              {busy ? "저장하는 중" : "정본에 저장"}
            </GlassButton>
          ) : null}
          {actions}
        </footer>
      ) : null}
    </section>
  );
}

function Message({ m, proposals, busy, onRetry, onApprove }: { m: AgentAReviewAnnotation; proposals: AgentAReviewProposal[]; busy: boolean; onRetry: () => void; onApprove: (p: AgentAReviewProposal) => void }) {
  return (
    <article className="aar-msg" data-ai={m.ai ? "" : undefined} data-message-id={m.id}>
      <p className="aar-msg__who">{m.ai ? m.author ?? "Agent-A" : "나"}</p>
      {m.writing ? (
        <p className="aar-msg__writing" role="status">답을 쓰는 중…</p>
      ) : m.ai ? (
        m.text ? <Markdown text={m.text} className="aar-msg__body" /> : null
      ) : (
        <p className="aar-msg__text">{m.text}</p>
      )}
      {m.error ? (
        <div className="aar-msg__error" role="status">
          <p>{m.error.message}</p>
          <p className="aar-msg__code">
            <code>{m.error.code}</code>
            {m.canRetry ? (
              <button type="button" className="vw-btn" disabled={busy} onClick={onRetry}>
                다시 요청
              </button>
            ) : null}
          </p>
        </div>
      ) : null}
      {m.extra ? <p className="aar-note">이 답에는 앱 수정안 같은 딸린 내용이 있습니다. 그 내용은 Agent-A 화면에서만 다룹니다.</p> : null}
      {proposals.map((p) => (
        <ProposalCard key={p.proposalId} proposal={p} busy={busy} onApprove={() => onApprove(p)} />
      ))}
    </article>
  );
}

export interface CommentPanelProps {
  view: PanelView;
  threads: ReviewThread[];
  turn: TurnItem[];
  loading: boolean;
  /** 새 댓글·답글을 쓸 수 있는지. 못 쓰면 까닭. */
  blocked: string | null;
  busy: boolean;
  error: string | null;
  draftOf: (key: string) => string;
  setDraft: (key: string, text: string) => void;
  onView: (view: PanelView) => void;
  onCreate: (target: Extract<PanelView, { kind: "new" }>["target"], text: string) => void;
  onReply: (threadId: string, text: string) => void;
  onResolve: (threadId: string, resolved: boolean) => void;
  onRemove: (id: string) => void;
  onRetry: (answerId: string) => void;
  onFork: (threadId: string) => void;
  onApprove: (p: AgentAReviewProposal) => void;
}

export function CommentPanel(p: CommentPanelProps) {
  const [showDone, setShowDone] = useState(false);
  const remove = useConfirmPress();
  const { view } = p;

  if (view.kind === "new") {
    const key = view.target.kind === "global" ? "new:global" : view.target.kind === "region" ? "new:region" : "new:quote";
    const text = p.draftOf(key);
    return (
      <section className="aar-pane" aria-label="새 댓글">
        <header className="aar-pane__head">
          <button type="button" className="aar-back" aria-label="댓글 목록으로" onClick={() => p.onView({ kind: "list" })}>←</button>
          <strong>{view.target.kind === "global" ? "문서 전체에 댓글" : view.target.kind === "region" ? "그림 영역에 질문" : "고른 글에 댓글"}</strong>
        </header>
        <div className="aar-pane__body">
          {view.target.kind === "quote" ? <blockquote className="aar-quote">{view.target.quote}</blockquote> : null}
          {view.target.kind === "region" ? <p className="aar-note">그림에 표시한 영역과 함께 Agent-A 에 보냅니다.</p> : null}
          {p.blocked ? <p className="aar-note" role="status">{p.blocked}</p> : null}
          {p.error ? <p className="aar-error" role="alert">{p.error}</p> : null}
        </div>
        {p.blocked ? null : (
          <Compose label="댓글" placeholder="묻거나 고쳐 달라고 적어 주세요" value={text} onChange={(v) => p.setDraft(key, v)} busy={p.busy} autoFocus
            onSend={() => p.onCreate(view.target, text)} />
        )}
      </section>
    );
  }

  if (view.kind === "thread") {
    const thread = p.threads.find((t) => t.root.id === view.id);
    if (!thread) {
      return (
        <section className="aar-pane" aria-label="댓글">
          <header className="aar-pane__head">
            <button type="button" className="aar-back" aria-label="댓글 목록으로" onClick={() => p.onView({ kind: "list" })}>←</button>
            <strong>댓글</strong>
          </header>
          <p className="aar-note aar-pane__body">{p.loading ? "댓글을 불러오는 중…" : "이 판에는 없는 댓글입니다."}</p>
        </section>
      );
    }
    const key = `reply:${thread.root.id}`;
    const text = p.draftOf(key);
    return (
      <section className="aar-pane" aria-label="댓글" data-thread={thread.root.id}>
        <header className="aar-pane__head">
          <button type="button" className="aar-back" aria-label="댓글 목록으로" onClick={() => p.onView({ kind: "list" })}>←</button>
          <strong>{kindLabel(thread.root)} 댓글</strong>
          {thread.root.resolved ? <Badge tone="ok">완료</Badge> : null}
        </header>
        <div className="aar-pane__tools" role="group" aria-label="댓글 관리">
          <button type="button" className="vw-btn" disabled={p.busy} onClick={() => p.onResolve(thread.root.id, !thread.root.resolved)}>
            {thread.root.resolved ? "다시 열기" : "완료"}
          </button>
          <button type="button" className="vw-btn" disabled={p.busy || thread.writing} onClick={() => p.onFork(thread.root.id)}>
            다른 조건으로 질문
          </button>
          <button type="button" className="vw-btn" data-armed={remove.armed ? "" : undefined} disabled={p.busy} onClick={() => remove.press(() => p.onRemove(thread.root.id))}>
            {remove.armed ? "한 번 더 눌러 지우기" : "지우기"}
          </button>
        </div>
        <div className="aar-pane__body" role="log" aria-label="댓글 대화">
          {thread.root.branchOf ? <p className="aar-note">‘{thread.root.branchOf}’에서 갈라 낸 질문입니다.</p> : null}
          {thread.root.quote ? <blockquote className="aar-quote">{thread.root.quote}</blockquote> : null}
          {thread.messages.map((m) => (
            <Message key={m.id} m={m} busy={p.busy} proposals={thread.proposals.filter((x) => x.annotationId === m.id)} onRetry={() => p.onRetry(m.id)} onApprove={p.onApprove} />
          ))}
          {p.error ? <p className="aar-error" role="alert">{p.error}</p> : null}
        </div>
        {p.blocked ? <p className="aar-note aar-pane__foot" role="status">{p.blocked}</p> : (
          <Compose label="답글" placeholder="답글 남기기" value={text} onChange={(v) => p.setDraft(key, v)} busy={p.busy} onSend={() => p.onReply(thread.root.id, text)} />
        )}
      </section>
    );
  }

  const open = p.threads.filter((t) => !t.done);
  const done = p.threads.filter((t) => t.done);
  const row = (t: ReviewThread) => (
    <li key={t.root.id}>
      <button type="button" className="aar-row" onClick={() => p.onView({ kind: "thread", id: t.root.id })}>
        <span className="aar-row__meta">
          <span className="aa-tag">{kindLabel(t.root)}</span>
          {t.writing ? <span className="aa-chip" data-state="running">답 쓰는 중</span> : null}
          {t.failed && !t.writing ? <Badge tone="danger">답 실패</Badge> : null}
          {t.needsDecision ? <Badge tone="accent">수정안</Badge> : null}
          {t.done ? <Badge tone="ok">{t.root.resolved ? "완료" : "저장됨"}</Badge> : null}
          {t.messages.length > 1 ? <span className="aar-row__count t-tabular">글 {t.messages.length}</span> : null}
        </span>
        <span className="aar-row__text">{oneLine(t.root.text || "(내용 없음)", 90)}</span>
        {t.root.quote ? <span className="aar-row__quote">{oneLine(t.root.quote, 70)}</span> : null}
      </button>
    </li>
  );
  return (
    <section className="aar-pane" aria-label="댓글 목록">
      <header className="aar-pane__head">
        <strong>댓글 <span className="t-tabular">{p.threads.length}</span></strong>
        {p.blocked ? null : (
          <GlassButton variant="glass" size="s" onClick={() => p.onView({ kind: "new", target: { kind: "global" } })}>
            전체 댓글
          </GlassButton>
        )}
      </header>
      <div className="aar-pane__body">
        {p.error ? <p className="aar-error" role="alert">{p.error}</p> : null}
        {p.turn.length ? (
          <section className="aar-turn" aria-label="내 차례">
            <h3 className="aar-turn__title">내 차례 <span className="t-tabular">{p.turn.length}</span></h3>
            {p.turn.map((item) => (
              <button key={item.answerId} type="button" className="aar-turn__row" onClick={() => p.onView({ kind: "thread", id: item.threadId })}>
                <span>{oneLine(item.text, 70)}</span>
                {item.needsDecision ? <Badge tone="accent">수정안</Badge> : null}
              </button>
            ))}
          </section>
        ) : null}
        {p.threads.length === 0 ? (
          <p className="aar-note">{p.loading ? "댓글을 불러오는 중…" : p.blocked ?? "글을 끌어 고르거나 ‘전체 댓글’을 눌러 Agent-A 에 물어보세요."}</p>
        ) : (
          <ul className="aar-list" aria-label="댓글">{open.map(row)}</ul>
        )}
        {done.length ? (
          <>
            <button type="button" className="aar-more" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
              끝난 댓글 <span className="t-tabular">{done.length}</span>
            </button>
            {showDone ? <ul className="aar-list" aria-label="끝난 댓글">{done.map(row)}</ul> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
