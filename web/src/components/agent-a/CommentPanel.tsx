// Agent-A 댓글 칸: 내 차례 · 댓글 목록 · 댓글 하나(대화·수정안·답글) · 새 댓글 쓰기. IAMCEO 공통 버튼·배지·마크다운을 쓴다.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AgentAReviewAiCatalog, AgentAReviewAiSettings, AgentAReviewAnnotation, AgentAReviewAttachment, AgentAReviewDiagramAnchor, AgentAReviewImageRegion, AgentAReviewProposal } from "@shared/agent-a";
import { GlassButton } from "../../glass";
import { fetchAttachment } from "../../lib/api";
import { AiPicker } from "./AiPicker";
import { anchorText } from "../../lib/agent-a-diagram";
import { THUMBS_UP, labelOf, type QuickLabel } from "../../lib/agent-a-labels";
import { PROPOSAL_LABEL, kindLabel, oneLine, wordDiff, type ReviewThread, type TurnItem } from "../../lib/agent-a-review";
import { enterSends, isComposing, useAutoGrow } from "../Composer";
import { Badge, Markdown, useConfirmPress } from "../ui";

export type PanelView =
  | { kind: "list" }
  | { kind: "chat" }
  | { kind: "thread"; id: string }
  | { kind: "new"; target: { kind: "quote"; quote: string } | { kind: "global" } | { kind: "region"; region: AgentAReviewImageRegion }
    /** 도식의 한 부분(또는 도식 전체). line 은 그 도식의 ```mermaid 줄이다. */
    | { kind: "diagram"; anchor: AgentAReviewDiagramAnchor; line: number } };

/** 글 쓰는 칸. Enter 로 보낸다(터치 기기는 단추). 보내는 동안 다시 눌리지 않는다. */
function Compose({ label, placeholder, value, onChange, onSend, busy, send = "보내기", autoFocus, extra }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; onSend: () => void; busy: boolean; send?: string; autoFocus?: boolean; /** 보내기 단추 앞에 두는 단추. */ extra?: ReactNode;
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
      {extra}
      <GlassButton variant="primary" size="s" disabled={busy || !value.trim()} onClick={onSend}>
        {busy ? "보내는 중" : send}
      </GlassButton>
    </div>
  );
}

/** 붙인 그림 하나. 헤더 인증으로 받아 blob 으로 그린다(주소를 그대로 img 에 넣지 않는다). */
export function Thumb({ url, name, local, onRemove, onDraw }: { url: string; name: string; /** 방금 고른 파일의 이 브라우저 안 주소. 있으면 서버에서 다시 받지 않는다. */ local?: string | null; onRemove?: () => void; /** 그림 위에 표시를 그린다. */ onDraw?: () => void }) {
  const [src, setSrc] = useState<string | null>(local ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (local) return setSrc(local);
    let stopped = false;
    let made: string | null = null;
    fetchAttachment({ url }).then((res) => res.blob()).then((blob) => {
      if (stopped) return;
      made = URL.createObjectURL(blob);
      setSrc(made);
    }).catch(() => !stopped && setFailed(true));
    return () => {
      stopped = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [url, local]);
  return (
    <span className="aar-thumb" data-attachment={name}>
      {src ? <img src={src} alt={name} draggable={false} /> : <span className="aar-thumb__wait">{failed ? "그림 없음" : "…"}</span>}
      <span className="aar-thumb__name">{name}</span>
      {onRemove ? <button type="button" className="aar-thumb__x" aria-label={`${name} 빼기`} onClick={onRemove}>×</button> : null}
      {onDraw ? <button type="button" className="aar-thumb__draw" aria-label={`${name} 위에 그리기`} onClick={onDraw}>그리기</button> : null}
    </span>
  );
}

/** 새 댓글에 붙일 그림 고르기. 고르면 바로 올려 두고, 댓글을 보낼 때 함께 붙는다. */
function Attach({ images, url, preview, busy, onAdd, onRemove, onDraw }: { images: AgentAReviewAttachment[]; url: (path: string) => string; preview: (path: string) => string | null; busy: boolean; onAdd: (file: File) => void; onRemove: (path: string) => void; onDraw: (path: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="aar-attach">
      {images.map((image) => <Thumb key={image.path} url={url(image.path)} local={preview(image.path)} name={image.name} onRemove={() => onRemove(image.path)} onDraw={busy ? undefined : () => onDraw(image.path)} />)}
      <button type="button" className="vw-btn" disabled={busy || images.length >= 10} onClick={() => input.current?.click()}>그림 붙이기</button>
      <input ref={input} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" aria-label="댓글에 붙일 그림" onChange={(e) => {
        for (const file of [...(e.target.files ?? [])].slice(0, 10 - images.length)) onAdd(file);
        e.target.value = "";
      }} />
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

function Message({ m, proposals, busy, labels, imageUrl, onRetry, onApprove }: { m: AgentAReviewAnnotation; proposals: AgentAReviewProposal[]; busy: boolean; labels: readonly QuickLabel[]; imageUrl: (path: string) => string; onRetry: () => void; onApprove: (p: AgentAReviewProposal) => void }) {
  const picked = m.aiSettings ? [m.aiSettings.providerId, m.aiSettings.model, m.aiSettings.reasoningEffort].filter(Boolean).join(" · ") : "";
  return (
    <article className="aar-msg" data-ai={m.ai ? "" : undefined} data-message-id={m.id}>
      <p className="aar-msg__who">{m.ai ? m.author ?? "Agent-A" : "나"}{picked ? <span className="aa-tag" title="이 글의 답에 고른 AI">{picked}</span> : null}</p>
      {m.writing ? (
        <p className="aar-msg__writing" role="status">답을 쓰는 중…</p>
      ) : m.ai ? (
        m.text ? <Markdown text={m.text} className="aar-msg__body" /> : null
      ) : m.label ? (
        <>
          <p className="aar-msg__text"><span className="aar-label" data-tone={labelOf(m.text, labels)?.tone ?? "yellow"}>{m.text}</span></p>
          {m.labelTip ? <p className="aar-card__meta">지침: {m.labelTip}</p> : null}
        </>
      ) : (
        <p className="aar-msg__text">{m.text || (m.kind === "deletion" ? "이 글을 지우자는 삭제 표시입니다." : "")}</p>
      )}
      {m.images.length ? <div className="aar-attach">{m.images.map((image) => <Thumb key={image.path} url={imageUrl(image.path)} name={image.name} />)}</div> : null}
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
  /** 답에 쓸 AI 목록과 지금 고른 값. 목록이 없으면(연결 안 됨) 고르는 칸을 보이지 않는다. */
  catalog: AgentAReviewAiCatalog | null;
  ai: AgentAReviewAiSettings;
  onAi: (next: AgentAReviewAiSettings) => void;
  /** 새 댓글에 붙이려고 올려 둔 그림. */
  images: AgentAReviewAttachment[];
  imageUrl: (path: string) => string;
  /** 방금 올린 그림의 미리 보기 주소(이 브라우저 안). 서버는 댓글에 붙기 전의 그림을 내주지 않는다. */
  imagePreview: (path: string) => string | null;
  onAttach: (file: File) => void;
  onDetach: (path: string) => void;
  /** 붙이려고 올려 둔 그림 위에 표시를 그린다. */
  onDrawImage: (path: string) => void;
  /** 빠른 라벨 목록(라벨 댓글의 색을 맞추는 데 쓴다). */
  labels: readonly QuickLabel[];
  onCreate: (target: Extract<PanelView, { kind: "new" }>["target"], text: string) => void;
  /** 고른 그림 영역에 '좋아요' 라벨을 바로 붙인다(원래 Agent-A 화면의 그림 영역 빠른 라벨). */
  onRegionGood: (region: AgentAReviewImageRegion) => void;
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
    const { target } = view;
    const key = target.kind === "global" ? "new:global" : target.kind === "region" ? "new:region" : target.kind === "diagram" ? "new:diagram" : "new:quote";
    const text = p.draftOf(key);
    const head = target.kind === "global" ? "문서 전체에 댓글" : target.kind === "region" ? "그림 영역에 질문" : target.kind === "diagram" ? (target.anchor.kind === "diagram" ? "도식 전체에 댓글" : "도식 부분에 댓글") : "고른 글에 댓글";
    // 그림 영역: '좋아요' 한 번으로 라벨을 붙인다. 글을 쓰거나 그림을 붙였으면 눌리지 않는다(쓰던 것을 버리지 않는다).
    const good = target.kind === "region" ? (
      <button type="button" className="aar-good" aria-label={`${THUMBS_UP.text} 라벨 붙이기`} title={THUMBS_UP.text} disabled={p.busy || Boolean(text.trim()) || p.images.length > 0} onClick={() => p.onRegionGood(target.region)}>
        {THUMBS_UP.emoji}
      </button>
    ) : undefined;
    return (
      <section className="aar-pane" aria-label="새 댓글">
        <header className="aar-pane__head">
          <button type="button" className="aar-back" aria-label="댓글 목록으로" onClick={() => p.onView({ kind: "list" })}>←</button>
          <strong>{head}</strong>
        </header>
        <div className="aar-pane__body">
          {view.target.kind === "quote" ? <blockquote className="aar-quote">{view.target.quote}</blockquote> : null}
          {target.kind === "diagram" ? <blockquote className="aar-quote">{anchorText(target.anchor)}</blockquote> : null}
          {view.target.kind === "region" ? <p className="aar-note">그림에 표시한 영역과 함께 Agent-A 에 보냅니다.</p> : null}
          {p.blocked ? <p className="aar-note" role="status">{p.blocked}</p> : null}
          {p.error ? <p className="aar-error" role="alert">{p.error}</p> : null}
        </div>
        {p.blocked ? null : (
          <div className="aar-pane__foot">
            <Attach images={p.images} url={p.imageUrl} preview={p.imagePreview} busy={p.busy} onAdd={p.onAttach} onRemove={p.onDetach} onDraw={p.onDrawImage} />
            <AiPicker catalog={p.catalog} value={p.ai} onChange={p.onAi} disabled={p.busy} />
            <Compose label="댓글" placeholder="묻거나 고쳐 달라고 적어 주세요" value={text} onChange={(v) => p.setDraft(key, v)} busy={p.busy} autoFocus extra={good}
              onSend={() => p.onCreate(view.target, text)} />
          </div>
        )}
      </section>
    );
  }

  if (view.kind === "chat") return null;

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
            <Message key={m.id} m={m} busy={p.busy} labels={p.labels} imageUrl={p.imageUrl} proposals={thread.proposals.filter((x) => x.annotationId === m.id)} onRetry={() => p.onRetry(m.id)} onApprove={p.onApprove} />
          ))}
          {p.error ? <p className="aar-error" role="alert">{p.error}</p> : null}
        </div>
        {p.blocked ? <p className="aar-note aar-pane__foot" role="status">{p.blocked}</p> : (
          <div className="aar-pane__foot">
            <AiPicker catalog={p.catalog} value={p.ai} onChange={p.onAi} disabled={p.busy} />
            <Compose label="답글" placeholder="답글 남기기" value={text} onChange={(v) => p.setDraft(key, v)} busy={p.busy} onSend={() => p.onReply(thread.root.id, text)} />
          </div>
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
        <span className="aar-row__text">{t.root.label ? <span className="aar-label" data-tone={labelOf(t.root.text, p.labels)?.tone ?? "yellow"}>{oneLine(t.root.text, 90)}</span> : oneLine(t.root.text || (t.root.kind === "deletion" ? "삭제 표시" : "(내용 없음)"), 90)}</span>
        {t.root.quote ? <span className="aar-row__quote">{oneLine(t.root.quote, 70)}</span> : null}
      </button>
    </li>
  );
  return (
    <section className="aar-pane" aria-label="댓글 목록">
      <header className="aar-pane__head">
        <strong>댓글 <span className="t-tabular">{p.threads.length}</span></strong>
        <GlassButton variant="glass" size="s" onClick={() => p.onView({ kind: "chat" })}>
          문서에 묻기
        </GlassButton>
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
