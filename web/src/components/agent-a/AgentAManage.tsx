// 문서 관리: 분기(옆 질문) · 수정안 · 정본 블록과 이전 판 · 순서와 배치 · 피드백(전송 자료·결과 가져오기) · 판 이력 · 다른 검토에 남은 초안과 기록.
// 원래 Agent-A 의 '문서 관리'(분기·변경안·정본·피드백·배치 보드)를 IAMCEO 부품으로 옮긴 것이다.
// 정본을 바꾸는 일(저장·되살리기·직접 고치기·보관·새 블록·순서)은 대표가 누를 때만 하고, 같은 누름을 다시 보내도 한 번만 반영된다(opId).
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentABlock, AgentAManageBranch, AgentAProposalStatus, AgentAReviewManage, AgentAReviewRecovery } from "@shared/agent-a";
import { GlassButton } from "../../glass";
import { ApiError, api, errorText } from "../../lib/api";
import { PROPOSAL_LABEL, wordDiff } from "../../lib/agent-a-review";
import { newId } from "../../lib/store";
import { Badge, MQ_DESKTOP, Modal, Time, useConfirmPress, useMediaQuery } from "../ui";
import { ProposalCard } from "./CommentPanel";
import { KIND_LABEL, LayoutBoard } from "./LayoutBoard";

type Tab = "branches" | "proposals" | "blocks" | "layout" | "feedback" | "versions" | "drafts";
const TABS: { key: Tab; label: string }[] = [
  { key: "proposals", label: "수정안" },
  { key: "blocks", label: "정본" },
  { key: "layout", label: "순서·배치" },
  { key: "branches", label: "분기" },
  { key: "feedback", label: "피드백" },
  { key: "versions", label: "판 이력" },
  { key: "drafts", label: "이전 초안·기록" },
];
/** Agent-A 의 상태 이름을 읽는 말로. */
const STATE: Record<string, string> = { proposed: "검토 전", accepted: "채택", held: "보류", rejected: "거절", not_sent: "미전송", queued: "준비됨", running: "실행 중", succeeded: "완료", failed: "실패", unknown: "상태 확인 필요", open: "열림", closed: "닫힘" };
const IMPORT_TEXT = /\.(md|markdown|txt)$/i;
const IMPORT_IMAGE: Record<string, "image/png" | "image/jpeg" | "image/webp"> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
type BlockKind = "markdown" | "table" | "mermaid" | "image";
const KINDS: BlockKind[] = ["markdown", "table", "mermaid", "image"];
const FIRST = "__first__";

function download(value: unknown, name: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const toBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** 실제 AI 를 부르는 일은 한 번 더 눌러야 한다. */
function RunJob({ disabled, onRun }: { disabled: boolean; onRun: () => void }) {
  const confirm = useConfirmPress();
  return (
    <button type="button" className="vw-btn" data-armed={confirm.armed ? "" : undefined} disabled={disabled} onClick={() => confirm.press(onRun)}>
      {confirm.armed ? "한 번 더 눌러 실행(AI 사용)" : "CLI 실행"}
    </button>
  );
}

/** 분기 하나: 질문·답변, 답변 결정, 후속 질문, 닫기. */
function BranchCard({ branch, parentTitle, busy, reason, onDecide, onFollow, onClose, onChild }: {
  branch: AgentAManageBranch; parentTitle: string | null; busy: boolean; reason: string;
  onDecide: (messageId: string, decision: "accepted" | "held" | "rejected") => void;
  onFollow: (text: string) => Promise<boolean>;
  onClose: () => void;
  onChild: (messageId: string) => void;
}) {
  const [follow, setFollow] = useState("");
  return (
    <section className="aar-card" aria-label={`분기 ${branch.title}`} data-branch={branch.id}>
      <header className="aar-card__head">
        <strong>{branch.title}</strong>
        <span className="aar-card__meta">{STATE[branch.status] ?? branch.status}</span>
      </header>
      <p className="aar-card__meta">대상: {branch.target}{parentTitle ? ` · 상위 분기 ‘${parentTitle}’` : ""}</p>
      {branch.messages.map((m) => (
        <div key={m.id} className="aar-history" data-role={m.role}>
          <p className="aar-history__title">{m.role === "assistant" ? "답변" : "질문"}{m.decision && m.decision !== "proposed" ? ` · ${STATE[m.decision] ?? m.decision}` : ""}</p>
          <p className="aar-msg__text">{m.body}</p>
          {m.reason ? <p className="aar-card__meta">사유: {m.reason}</p> : null}
          {m.role === "assistant" ? (
            <div className="aar-actions">
              <button type="button" className="vw-btn" disabled={busy} onClick={() => onDecide(m.id, "accepted")}>답변 채택</button>
              <button type="button" className="vw-btn" disabled={busy} onClick={() => onDecide(m.id, "held")}>보류</button>
              <button type="button" className="vw-btn" disabled={busy} onClick={() => onDecide(m.id, "rejected")}>거절</button>
              <button type="button" className="vw-btn" disabled={busy} onClick={() => onChild(m.id)}>이 답변에서 새 분기</button>
            </div>
          ) : null}
        </div>
      ))}
      <label className="aar-field">후속 질문<textarea rows={2} value={follow} onChange={(e) => setFollow(e.target.value)} /></label>
      <div className="aar-actions">
        <GlassButton variant="glass" size="s" disabled={busy || !follow.trim()} onClick={() => void onFollow(follow.trim()).then((ok) => ok && setFollow(""))}>후속 질문 저장</GlassButton>
        <button type="button" className="vw-btn" disabled={busy || branch.status === "closed"} title={reason ? `사유: ${reason}` : undefined} onClick={onClose}>분기 닫기</button>
      </div>
    </section>
  );
}
const FILTERS: (AgentAProposalStatus | "all")[] = ["pending", "held", "conflict", "rejected", "applied", "all"];

function Restore({ disabled, revision, unarchive, onRestore }: { disabled: boolean; revision: number; /** 보관된 블록을 그 판의 내용으로 다시 꺼낸다. */ unarchive: boolean; onRestore: () => void }) {
  const confirm = useConfirmPress();
  return (
    <button type="button" className="vw-btn" data-armed={confirm.armed ? "" : undefined} disabled={disabled} onClick={() => confirm.press(onRestore)}>
      {confirm.armed ? "한 번 더 눌러 되살리기" : unarchive ? `판 ${revision} 내용으로 다시 꺼내기` : `판 ${revision} 내용으로 되살리기`}
    </button>
  );
}

function Archive({ disabled, onArchive }: { disabled: boolean; onArchive: () => void }) {
  const confirm = useConfirmPress();
  return (
    <button type="button" className="vw-btn" data-armed={confirm.armed ? "" : undefined} disabled={disabled} onClick={() => confirm.press(onArchive)}>
      {confirm.armed ? "한 번 더 눌러 보관" : "보관"}
    </button>
  );
}

function BlockCard({ block, busy, onEdit, onRestore, onReview, onArchive }: {
  block: AgentABlock; busy: boolean;
  onEdit: (input: { title: string; summary: string; body: string }) => Promise<boolean>;
  onRestore: (historyRevision: number) => void;
  onReview: () => void;
  onArchive: () => void;
}) {
  const [edit, setEdit] = useState<{ title: string; summary: string; body: string; revision: number } | null>(null);
  const reviewed = block.reviewedRevision === block.revision;
  return (
    <section className="aar-card" aria-label={`블록 ${block.title}`} data-block={block.id}>
      <header className="aar-card__head">
        <strong>{block.title}</strong>
        <span className="aar-card__meta t-tabular">
          {KIND_LABEL[block.kind] ?? block.kind} · 판 {block.revision}{block.archived ? " · 보관됨" : ""}
          {block.archived ? null : reviewed ? <> <Badge tone="ok">검토함</Badge></> : block.reviewedRevision !== null ? <> <Badge tone="accent">고친 뒤 검토 전</Badge></> : null}
        </span>
      </header>
      {block.summary && !edit ? <p className="aar-card__meta" data-summary="">요약: {block.summary}</p> : null}
      {edit ? (
        <div className="aar-edit">
          <label className="aar-field">제목<input value={edit.title} maxLength={500} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
          <label className="aar-field">요약<input value={edit.summary} maxLength={10000} placeholder="제목 아래에 보일 한두 줄(비워도 됩니다)" onChange={(e) => setEdit({ ...edit, summary: e.target.value })} /></label>
          <label className="aar-field">{block.kind === "image" ? "그림 설명" : "본문"}<textarea rows={10} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
          {block.kind === "table" ? <p className="aar-card__meta">표 본문은 {'{"headers":["머리"…],"rows":[["칸"…]…]}'} 모양입니다.</p> : null}
          {edit.revision !== block.revision ? <p className="aar-note" role="status">그사이 이 블록이 판 {block.revision}(으)로 바뀌었습니다. 고치던 글은 그대로 두었습니다. 닫고 다시 열어 최신 판에서 고쳐 주세요.</p> : null}
          <p className="aar-card__meta">저장하면 새 판이 생기고, 검토 표시는 다시 해야 합니다.</p>
          <div className="aar-actions">
            <GlassButton variant="primary" size="s" disabled={busy || !edit.title.trim() || edit.revision !== block.revision} onClick={() => void onEdit({ title: edit.title, summary: edit.summary, body: edit.body }).then((ok) => ok && setEdit(null))}>
              {busy ? "저장하는 중" : "정본에 저장"}
            </GlassButton>
            <GlassButton variant="ghost" size="s" disabled={busy} onClick={() => setEdit(null)}>고치기 그만</GlassButton>
          </div>
        </div>
      ) : block.archived ? null : (
        <div className="aar-actions">
          <button type="button" className="vw-btn" disabled={busy} onClick={() => setEdit({ title: block.title, summary: block.summary, body: block.body, revision: block.revision })}>직접 고치기</button>
          {reviewed ? null : <button type="button" className="vw-btn" disabled={busy} onClick={onReview}>검토함으로 표시</button>}
          <Archive disabled={busy} onArchive={onArchive} />
        </div>
      )}
      {block.sources.length ? (
        <details className="aar-fold">
          <summary>근거 <span className="t-tabular">{block.sources.length}</span>개</summary>
          <ul className="aar-sources" aria-label="근거">{block.sources.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </details>
      ) : null}
      {block.history.length ? (
        <details className="aar-fold">
          <summary>이전 판 <span className="t-tabular">{block.history.length}</span>개</summary>
          {[...block.history].reverse().map((h) => (
            <div key={h.revision} className="aar-history">
              <p className="aar-history__title">판 {h.revision} · {h.title}{h.archived ? " · 보관된 판" : ""}</p>
              <p className="aar-diff">
                {wordDiff(h.body, block.body).map((p, i) => (p.kind === "add" ? <ins key={i}>{p.text}</ins> : p.kind === "del" ? <del key={i}>{p.text}</del> : <span key={i}>{p.text}</span>))}
              </p>
              {/* 보관된 블록은 보관 전 판으로만 다시 꺼낸다(보관된 판으로 되살려도 보관된 채다). */}
              {block.archived && h.archived ? null : <Restore disabled={busy || edit !== null} revision={h.revision} unarchive={block.archived} onRestore={() => onRestore(h.revision)} />}
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}

/** 새 블록: 글·표·도식·그림 가운데 하나를 고른 자리에 더한다. */
function NewBlock({ blocks, busy, onAdd }: {
  blocks: AgentABlock[]; busy: boolean;
  onAdd: (input: { afterId: string | null; kind: BlockKind; title: string; body: string; file: File | null }) => Promise<boolean>;
}) {
  const active = blocks.filter((b) => !b.archived);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<BlockKind>("markdown");
  const [body, setBody] = useState("");
  const [after, setAfter] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // 고르지 않았으면 맨 뒤(마지막 블록 뒤)다. 블록이 없으면 맨 앞이다.
  const place = after !== null && (after === FIRST || active.some((b) => b.id === after)) ? after : active.at(-1)?.id ?? FIRST;
  const ready = Boolean(title.trim()) && (kind === "image" ? file !== null : Boolean(body.trim()));
  return (
    <details className="aar-fold">
      <summary>새 블록 더하기</summary>
      <div className="aar-edit" aria-label="새 블록">
        <label className="aar-field">블록 제목<input value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="aar-field">종류
          <select value={kind} onChange={(e) => setKind(e.target.value as BlockKind)}>
            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="aar-field">넣을 자리
          <select value={place} onChange={(e) => setAfter(e.target.value)}>
            <option value={FIRST}>맨 앞</option>
            {active.map((b) => <option key={b.id} value={b.id}>‘{b.title}’ 뒤</option>)}
          </select>
        </label>
        {kind === "image" ? (
          <>
            <div className="aar-actions">
              <button type="button" className="vw-btn" disabled={busy} onClick={() => input.current?.click()}>{file ? "그림 바꾸기" : "그림 고르기"}</button>
              <span className="aar-card__meta">{file ? file.name : "PNG·JPEG·WebP, 4MB 까지"}</span>
              <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="새 블록의 그림" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            </div>
            <label className="aar-field">그림 설명(선택)<textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></label>
          </>
        ) : (
          <label className="aar-field">본문<textarea rows={6} value={body} placeholder={kind === "table" ? '{"headers":["항목","값"],"rows":[["기간","2주"]]}' : kind === "mermaid" ? "flowchart LR\n  A --> B" : ""} onChange={(e) => setBody(e.target.value)} /></label>
        )}
        {kind === "table" ? <p className="aar-card__meta">표 본문은 {'{"headers":["머리"…],"rows":[["칸"…]…]}'} 모양의 JSON 입니다.</p> : null}
        {kind === "mermaid" ? <p className="aar-card__meta">도식은 Mermaid 글로 적습니다. 본문에서 그림으로 보입니다.</p> : null}
        <div className="aar-actions">
          <GlassButton variant="glass" size="s" disabled={busy || !ready} onClick={() => void onAdd({ afterId: place === FIRST ? null : place, kind, title: title.trim(), body, file: kind === "image" ? file : null }).then((ok) => {
            if (!ok) return;
            setTitle("");
            setBody("");
            setFile(null);
            setAfter(null);
          })}>{busy ? "더하는 중" : "블록 더하기"}</GlassButton>
        </div>
      </div>
    </details>
  );
}

/** 목표와 제약: 문서 머리의 목표 글과 제약 목록. 고치면 문맥이 바뀌어, 그 전에 나온 수정안은 새 문맥에서 다시 확인해야 한다. */
function ContextCard({ goal, constraints, revision, busy, onSave }: { goal: string; constraints: string[]; revision: number; busy: boolean; onSave: (input: { goal: string; constraints: string[]; revision: number }) => Promise<boolean> }) {
  const [edit, setEdit] = useState<{ goal: string; constraints: string; revision: number } | null>(null);
  return (
    <details className="aar-fold">
      <summary>목표와 제약</summary>
      {edit ? (
        <div className="aar-edit" aria-label="목표와 제약 고치기">
          <label className="aar-field">목표<textarea rows={3} value={edit.goal} maxLength={10000} onChange={(e) => setEdit({ ...edit, goal: e.target.value })} /></label>
          <label className="aar-field">제약(한 줄에 하나)<textarea rows={4} value={edit.constraints} onChange={(e) => setEdit({ ...edit, constraints: e.target.value })} /></label>
          {edit.revision !== revision ? <p className="aar-note" role="status">그사이 목표와 제약이 바뀌었습니다. 쓰던 글은 그대로 두었습니다. 닫고 다시 열어 최신 내용에서 고쳐 주세요.</p> : null}
          <p className="aar-card__meta">목표와 제약을 바꾸면 그 전에 나온 수정안은 새 내용에서 다시 확인해야 합니다.</p>
          <div className="aar-actions">
            <GlassButton variant="primary" size="s" disabled={busy || !edit.goal.trim() || edit.revision !== revision} onClick={() => void onSave({ goal: edit.goal, constraints: edit.constraints.split("\n"), revision: edit.revision }).then((ok) => ok && setEdit(null))}>
              {busy ? "저장하는 중" : "목표와 제약 저장"}
            </GlassButton>
            <GlassButton variant="ghost" size="s" disabled={busy} onClick={() => setEdit(null)}>고치기 그만</GlassButton>
          </div>
        </div>
      ) : (
        <div className="aar-edit" aria-label="목표와 제약">
          <p className="aar-msg__text">{goal || "목표가 비어 있습니다."}</p>
          {constraints.length ? <ul className="aar-sources" aria-label="제약">{constraints.map((c, i) => <li key={i}>{c}</li>)}</ul> : <p className="aar-card__meta">제약이 없습니다.</p>}
          <div className="aar-actions">
            <button type="button" className="vw-btn" disabled={busy} onClick={() => setEdit({ goal, constraints: constraints.join("\n"), revision })}>목표와 제약 고치기</button>
          </div>
        </div>
      )}
    </details>
  );
}

export function AgentAManage({ fileId, projectId, open, recoveries, onClose, onChanged, onOpenReview }: {
  fileId: string;
  /** 새 문서 만들기·파일 가져오기가 문서를 등록할 프로젝트. */
  projectId: string;
  open: boolean;
  recoveries: AgentAReviewRecovery[];
  onClose: () => void;
  /** 정본이 바뀌었다. 본문을 최신 정본으로 다시 연다. */
  onChanged: (message: string) => void;
  onOpenReview: (sessionId: string) => void;
}) {
  const desktop = useMediaQuery(MQ_DESKTOP);
  const [data, setData] = useState<AgentAReviewManage | null>(null);
  const [tab, setTab] = useState<Tab>("proposals");
  const [filter, setFilter] = useState<AgentAProposalStatus | "all">("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 한 번에 반영할 수정안. */
  const [picked, setPicked] = useState<string[]>([]);
  /** 채택·보류·거절·닫기에 붙일 사유(선택). */
  const [reason, setReason] = useState("");
  const [question, setQuestion] = useState("");
  const [blockId, setBlockId] = useState("");
  const [childOf, setChildOf] = useState<{ branchId: string; messageId: string } | null>(null);
  const [pickedFeedback, setPickedFeedback] = useState<string[]>([]);
  const [template, setTemplate] = useState("");
  const [importText, setImportText] = useState("");
  const [newDoc, setNewDoc] = useState({ title: "", markdown: "" });
  const importInput = useRef<HTMLInputElement>(null);
  // 같은 일(같은 수정안·같은 블록)을 다시 누르면 같은 요청 id 로 보낸다. 끝난 일의 id 는 버린다.
  const ops = useRef(new Map<string, string>());
  const opId = (key: string) => {
    let id = ops.current.get(key);
    if (!id) ops.current.set(key, (id = newId()));
    return id;
  };

  const load = useCallback(async () => {
    try {
      setData(await api.agentAReview.manage(fileId));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [fileId]);
  useEffect(() => {
    if (!open) return;
    setNotice(null);
    void load();
  }, [open, load]);

  const run = async (key: string, work: (id: string) => Promise<string | null>, changed: boolean): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await work(opId(key));
      ops.current.delete(key);
      await load();
      if (message) {
        setNotice(message);
        if (changed) onChanged(message);
      }
      return true;
    } catch (e) {
      // 그사이 다른 곳에서 바뀌어 거절된 일은 반영되지 않았다. 최신 내용을 다시 읽고(오류 글은 그대로 보인다), 다음 누름은 새 요청으로 보낸다.
      if (e instanceof ApiError && e.code === "AGENT_A_REVISION_CONFLICT") {
        ops.current.delete(key);
        await load();
      }
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const shown = data?.proposals.filter((p) => filter === "all" || p.status === filter) ?? [];
  const titleOf = (blockId: string, fallback: string) => data?.blocks.find((b) => b.id === blockId)?.title ?? fallback;
  return (
    <Modal open={open} onClose={onClose} title="문서 관리">
      <div className="aar-manage">
        <div className="fl-chips aar-manage__tabs" role="group" aria-label="문서 관리 갈래">
          {TABS.map((t) => (
            <button key={t.key} type="button" className="fl-chip" aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === "drafts" && recoveries.length ? <span className="t-tabular">{recoveries.length}</span> : null}
            </button>
          ))}
        </div>
        {error ? <p className="aar-error" role="alert">{error}</p> : null}
        {notice ? <p className="aar-note" role="status">{notice}</p> : null}
        {!data && !error ? <p className="aar-note" role="status">문서를 불러오는 중…</p> : null}

        {data && tab === "proposals" ? (
          <>
            <div className="fl-chips" role="group" aria-label="수정안 상태로 거르기">
              {FILTERS.map((f) => (
                <button key={f} type="button" className="fl-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {f === "all" ? "모두" : PROPOSAL_LABEL[f]} <span className="t-tabular">{f === "all" ? data.proposals.length : data.proposals.filter((p) => p.status === f).length}</span>
                </button>
              ))}
            </div>
            {shown.length === 0 ? <p className="aar-note">이 상태의 수정안이 없습니다.</p> : null}
            {shown.some((p) => p.applicable) ? (
              <div className="aar-actions">
                <GlassButton variant="glass" size="s" disabled={busy || picked.length === 0} onClick={() => void run(`applymany:${[...picked].sort().join(",")}`, async (id) => {
                  const r = await api.agentAReview.applyMany(fileId, picked, id);
                  setPicked([]);
                  return r.verified ? `고른 수정안 ${picked.length}개를 한 번에 정본에 저장했습니다(판 ${r.artifactRevision}).` : `저장은 됐지만 정본 본문 확인이 맞지 않습니다(판 ${r.artifactRevision}).`;
                }, true)}>
                  고른 <span className="t-tabular">{picked.length}</span>개 한 번에 저장
                </GlassButton>
                <span className="aar-card__meta">전부 되거나 전부 안 됩니다.</span>
              </div>
            ) : null}
            {shown.map((p) => (
              <ProposalCard
                key={p.id}
                busy={busy}
                proposal={{ status: p.status, reason: p.reason, staleReason: p.staleReason, operations: p.operations.map((op) => ({ op: op.op, blockId: op.blockId, title: op.blockTitle || titleOf(op.blockId, op.title ?? "수정안"), before: op.before, after: op.after })) }}
                onApprove={p.applicable ? () => void run(`apply:${p.id}`, async (id) => {
                  const r = await api.agentAReview.decide(fileId, p.id, "apply", id);
                  return r.verified ? `정본에 저장했습니다(판 ${r.artifactRevision}).` : `저장은 됐지만 정본 본문 확인이 맞지 않습니다(판 ${r.artifactRevision}).`;
                }, true) : undefined}
                actions={
                  <>
                    {p.applicable ? (
                      <label className="aar-check">
                        <input type="checkbox" checked={picked.includes(p.id)} disabled={busy} onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))} />
                        함께 저장
                      </label>
                    ) : null}
                    {p.status !== "held" ? <button type="button" className="vw-btn" disabled={busy} onClick={() => void run(`held:${p.id}`, async (id) => { await api.agentAReview.decide(fileId, p.id, "held", id); return "수정안을 보류했습니다. 정본은 그대로입니다."; }, false)}>보류</button> : null}
                    <button type="button" className="vw-btn" disabled={busy} onClick={() => void run(`rejected:${p.id}`, async (id) => { await api.agentAReview.decide(fileId, p.id, "rejected", id); return "수정안을 거절했습니다. 정본은 그대로입니다."; }, false)}>거절</button>
                  </>
                }
              />
            ))}
          </>
        ) : null}

        {data && tab === "blocks" ? (
          <>
            <p className="aar-note">지금 정본은 판 <span className="t-tabular">{data.artifactRevision}</span>입니다. 되살리기와 직접 고치기는 새 판을 만들고, 이전 판은 그대로 남습니다.</p>
            {data.blocks.map((b) => (
              <BlockCard key={b.id} block={b} busy={busy}
                onEdit={(input) => run(`edit:${b.id}:${b.revision}`, async (id) => {
                  const r = await api.agentAReview.edit(fileId, { blockId: b.id, revision: b.revision, title: input.title, summary: input.summary, body: input.body, opId: id, contextRevision: data.contextRevision });
                  return `정본에 저장했습니다(판 ${r.artifactRevision}).`;
                }, true)}
                onRestore={(historyRevision) => void run(`restore:${b.id}:${b.revision}:${historyRevision}`, async (id) => {
                  const r = await api.agentAReview.restore(fileId, { blockId: b.id, revision: b.revision, historyRevision, opId: id, contextRevision: data.contextRevision, layoutRevision: data.layoutRevision });
                  return `판 ${historyRevision}의 내용을 새 판으로 되살렸습니다(판 ${r.artifactRevision}).`;
                }, true)}
                onReview={() => void run(`reviewed:${b.id}:${b.revision}`, async (id) => {
                  await api.agentAReview.blockReview(fileId, { blockId: b.id, revision: b.revision, opId: id });
                  return `‘${b.title}’을(를) 검토함으로 표시했습니다. 본문은 그대로입니다.`;
                }, false)}
                onArchive={() => void run(`archive:${b.id}:${b.revision}`, async (id) => {
                  const r = await api.agentAReview.blockArchive(fileId, { blockId: b.id, revision: b.revision, opId: id, contextRevision: data.contextRevision, layoutRevision: data.layoutRevision });
                  return `‘${b.title}’을(를) 보관했습니다(판 ${r.artifactRevision}). 이전 판에서 다시 꺼낼 수 있습니다.`;
                }, true)}
              />
            ))}
            <NewBlock blocks={data.blocks} busy={busy} onAdd={(input) => run(`insert:${input.afterId ?? FIRST}:${input.kind}:${input.title}:${input.body}:${input.file ? `${input.file.name}:${input.file.size}:${input.file.lastModified}` : ""}`, async (id) => {
              let image: { name: string; mediaType: "image/png" | "image/jpeg" | "image/webp"; base64: string } | null = null;
              if (input.file) {
                const type = input.file.type;
                if (type !== "image/png" && type !== "image/jpeg" && type !== "image/webp") throw new Error("PNG·JPEG·WebP 그림만 넣을 수 있습니다");
                if (input.file.size > 4 * 1024 * 1024) throw new Error("그림은 4MB 까지입니다");
                image = { name: input.file.name.slice(0, 500), mediaType: type, base64: await toBase64(input.file) };
              }
              const r = await api.agentAReview.blockInsert(fileId, { opId: id, afterId: input.afterId, kind: input.kind, title: input.title, body: input.body, image, contextRevision: data.contextRevision, layoutRevision: data.layoutRevision });
              return `새 블록 ‘${input.title}’을(를) 더했습니다(판 ${r.artifactRevision}).`;
            }, true)} />
            <ContextCard goal={data.goal} constraints={data.constraints} revision={data.contextRevision} busy={busy} onSave={(input) => run(`context:${input.revision}:${input.goal}:${input.constraints.join("\n")}`, async (id) => {
              const r = await api.agentAReview.contextUpdate(fileId, { opId: id, goal: input.goal, constraints: input.constraints, contextRevision: input.revision });
              return `목표와 제약을 저장했습니다(판 ${r.artifactRevision}).`;
            }, true)} />
            <details className="aar-fold">
              <summary>변경 이력 <span className="t-tabular">{data.events.length}</span>건</summary>
              <ol className="aar-versions" aria-label="변경 이력">
                {data.events.map((e) => (
                  <li key={e.seq}>
                    <span className="t-tabular">#{e.seq}</span>
                    <span>{e.type}</span>
                    <Time iso={e.at} />
                  </li>
                ))}
              </ol>
            </details>
            <details className="aar-fold">
              <summary>새 문서 만들기 · 파일 가져오기</summary>
              <label className="aar-field">문서 제목<input value={newDoc.title} maxLength={200} onChange={(e) => setNewDoc({ ...newDoc, title: e.target.value })} /></label>
              <label className="aar-field">처음 본문(마크다운)<textarea rows={5} value={newDoc.markdown} maxLength={200000} onChange={(e) => setNewDoc({ ...newDoc, markdown: e.target.value })} /></label>
              <div className="aar-actions">
                <GlassButton variant="glass" size="s" disabled={busy || !newDoc.title.trim() || !newDoc.markdown.trim()} onClick={() => void run("newdoc", async () => {
                  await api.agentACreateDoc(projectId, { title: newDoc.title.trim(), markdown: newDoc.markdown });
                  setNewDoc({ title: "", markdown: "" });
                  return "새 문서를 만들었습니다. 자료 목록에서 엽니다.";
                }, false)}>새 문서 만들기</GlassButton>
                <button type="button" className="vw-btn" disabled={busy} onClick={() => importInput.current?.click()}>파일 가져오기</button>
                <input ref={importInput} type="file" multiple hidden accept=".md,.markdown,.txt,.png,.jpg,.jpeg,.webp" aria-label="문서 파일 가져오기" onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (!files.length) return;
                  void run("import", async () => {
                    // 파일마다 따로 문서 하나를 만든다. 지금 열어 둔 문서와 초안은 그대로 둔다.
                    const failed: string[] = [];
                    let made = 0;
                    for (const file of files) {
                      try {
                        const title = file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "가져온 문서";
                        const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
                        if (IMPORT_TEXT.test(file.name)) {
                          const text = await file.text();
                          if (!text.trim() || text.length > 200_000) throw new Error("비었거나 너무 깁니다");
                          await api.agentACreateDoc(projectId, { title, markdown: text });
                        } else if (IMPORT_IMAGE[ext]) {
                          if (file.size > 4 * 1024 * 1024) throw new Error("4MB 를 넘습니다");
                          await api.agentACreateDoc(projectId, { title, markdown: title, images: [{ title, name: file.name.slice(0, 500), mediaType: IMPORT_IMAGE[ext], base64: await toBase64(file) }] });
                        } else throw new Error("가져올 수 없는 종류입니다");
                        made++;
                      } catch (err) {
                        failed.push(`${file.name}(${errorText(err)})`);
                      }
                    }
                    if (failed.length && !made) throw new Error(`가져오지 못했습니다: ${failed.join(", ")}`);
                    return `문서 ${made}개를 가져왔습니다.${failed.length ? ` 못 가져온 파일: ${failed.join(", ")}` : ""} 자료 목록에서 엽니다.`;
                  }, false);
                }} />
              </div>
              <p className="aar-card__meta">MD·TXT 는 글 문서로, PNG·JPEG·WebP 는 그림 문서로 파일마다 하나씩 만듭니다.</p>
            </details>
          </>
        ) : null}

        {data && tab === "layout" ? (
          <>
            <p className="aar-note">순서와 배치를 바꾸면 본문이 새 순서로 다시 열립니다. 블록의 글은 바뀌지 않습니다.</p>
            <LayoutBoard blocks={data.blocks.filter((b) => !b.archived)} busy={busy} board={desktop}
              onOrder={(ids) => void run(`order:${ids.join(",")}`, async (id) => {
                await api.agentAReview.blocksReorder(fileId, { opId: id, blockIds: ids, layoutRevision: data.layoutRevision });
                return "읽는 순서를 바꿨습니다.";
              }, true)}
              onLayout={(blockId, layout) => run(`layout:${blockId}:${layout.x}:${layout.y}:${layout.width}:${layout.height}`, async (id) => {
                await api.agentAReview.layoutSet(fileId, { opId: id, blockId, layout, layoutRevision: data.layoutRevision });
                return "배치를 저장했습니다.";
              }, true)} />
          </>
        ) : null}

        {data && tab === "branches" ? (
          <>
            <p className="aar-note">분기는 정본 옆에서 이어 가는 질문입니다. 답변을 채택해도 정본은 바뀌지 않고, 정본 반영은 ‘수정안’에서 따로 고릅니다.</p>
            <label className="aar-field">판단 사유(선택)<input value={reason} maxLength={1000} placeholder="채택·보류·거절·닫기 사유" onChange={(e) => setReason(e.target.value)} /></label>
            {data.branches.length === 0 ? <p className="aar-note">저장된 분기가 없습니다.</p> : null}
            {data.branches.map((b) => (
              <BranchCard key={b.id} branch={b} busy={busy} reason={reason} parentTitle={b.parentId ? data.branches.find((x) => x.id === b.parentId)?.title ?? null : null}
                onDecide={(messageId, decision) => void run(`answer:${b.id}:${messageId}:${decision}`, async (id) => {
                  await api.agentAReview.branchDecide(fileId, { opId: id, branchId: b.id, messageId, decision, reason });
                  return decision === "accepted" ? "답변을 채택했습니다. 정본은 바뀌지 않습니다." : decision === "held" ? "답변을 보류했습니다." : "답변을 거절했습니다.";
                }, false)}
                onFollow={(text) => run(`follow:${b.id}:${text}`, async (id) => {
                  await api.agentAReview.branchMessage(fileId, { opId: id, branchId: b.id, text });
                  return "후속 질문을 저장했습니다. ‘피드백’에서 전송 자료로 준비합니다.";
                }, false)}
                onClose={() => void run(`close:${b.id}`, async (id) => {
                  const r = await api.agentAReview.branchClose(fileId, { opId: id, branchId: b.id, reason });
                  const left = [r.unanswered ? `답 없는 질문 ${r.unanswered}` : "", r.openChildren ? `열린 하위 분기 ${r.openChildren}` : "", r.unapplied ? `반영 안 한 수정안 ${r.unapplied}` : ""].filter(Boolean).join(" · ");
                  return `분기를 닫았습니다.${left ? ` 남은 것: ${left}.` : ""} 후속 질문을 더하면 다시 열립니다.`;
                }, false)}
                onChild={(messageId) => setChildOf({ branchId: b.id, messageId })}
              />
            ))}
            <section className="aar-card" aria-label="새 분기">
              <header className="aar-card__head"><strong>{childOf ? "답변에서 새 분기" : "블록에서 새 분기"}</strong></header>
              {childOf ? (
                <p className="aar-card__meta">고른 답변을 기준으로 질문합니다. <button type="button" className="aa-link" onClick={() => setChildOf(null)}>블록 질문으로</button></p>
              ) : (
                <label className="aar-field">질문 대상
                  <select value={blockId || data.blocks.find((b) => !b.archived)?.id || ""} onChange={(e) => setBlockId(e.target.value)}>
                    {data.blocks.filter((b) => !b.archived).map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
                  </select>
                </label>
              )}
              <label className="aar-field">새 질문<textarea rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
              <div className="aar-actions">
                <GlassButton variant="glass" size="s" disabled={busy || !question.trim() || (!childOf && !data.blocks.some((b) => !b.archived))} onClick={() => void run(`branch:${childOf ? `${childOf.branchId}:${childOf.messageId}` : blockId}:${question}`, async (id) => {
                  await api.agentAReview.branchCreate(fileId, { opId: id, question: question.trim(), ...(childOf ? { parent: childOf } : { blockId: blockId || data.blocks.find((b) => !b.archived)!.id }) });
                  setQuestion("");
                  setChildOf(null);
                  return "새 분기를 만들었습니다. 정본은 바뀌지 않습니다.";
                }, false)}>분기 만들기</GlassButton>
              </div>
            </section>
          </>
        ) : null}

        {data && tab === "feedback" ? (
          <>
            <p className="aar-note">분기의 질문을 골라 전송 자료를 준비합니다. 자료를 내보내 수동으로 주고받거나, Agent-A 에 설정된 CLI 로 실행합니다{data.adapter ? "" : "(지금 이 Agent-A 는 자동 연동이 꺼져 있어 수동 교환만 됩니다)"}.</p>
            {data.feedback.length === 0 ? <p className="aar-note">저장된 질문이 없습니다.</p> : null}
            {data.feedback.map((f) => (
              <label key={f.id} className="aar-card aar-check" data-feedback={f.id}>
                <input type="checkbox" checked={pickedFeedback.includes(f.id)} disabled={busy || f.state !== "not_sent" && f.state !== "failed" && f.state !== "unknown"} onChange={(e) => setPickedFeedback((cur) => (e.target.checked ? [...cur, f.id] : cur.filter((x) => x !== f.id)))} />
                <span>
                  <span className="aar-msg__text">{f.message}</span>
                  <span className="aar-card__meta">{f.branchTitle} · {STATE[f.state] ?? f.state}</span>
                </span>
              </label>
            ))}
            <label className="aar-field">추가 전달 지침(선택)<textarea rows={2} value={template} maxLength={4000} onChange={(e) => setTemplate(e.target.value)} /></label>
            <div className="aar-actions">
              <GlassButton variant="glass" size="s" disabled={busy || pickedFeedback.length === 0} onClick={() => void run(`batch:${[...pickedFeedback].sort().join(",")}:${template}`, async (id) => {
                await api.agentAReview.feedbackPrepare(fileId, { opId: id, feedbackIds: pickedFeedback, ...(template.trim() ? { template: template.trim() } : {}) });
                setPickedFeedback([]);
                return "전송 자료를 준비했습니다. 아래 전송 기록에서 내보내거나 실행합니다.";
              }, false)}>
                고른 <span className="t-tabular">{pickedFeedback.length}</span>개 자료 준비
              </GlassButton>
            </div>
            <section className="aar-card" aria-label="전송 기록">
              <header className="aar-card__head"><strong>전송 기록</strong></header>
              {data.jobs.length === 0 ? <p className="aar-card__meta">전송 기록이 없습니다.</p> : null}
              {data.jobs.map((j) => (
                <div key={j.id} className="aar-history" data-job={j.id}>
                  <p className="aar-history__title">{STATE[j.state] ?? j.state} · 질문 <span className="t-tabular">{j.feedback}</span>개</p>
                  {j.error ? <p className="aar-card__meta" role="status">{j.error}</p> : null}
                  <div className="aar-actions">
                    <button type="button" className="vw-btn" disabled={busy} onClick={() => void run(`export:${j.id}`, async () => { download(await api.agentAReview.jobExport(fileId, j.id), `agent-a-${j.id}.json`); return "전송 자료를 내보냈습니다."; }, false)}>JSON 내보내기</button>
                    <RunJob disabled={busy || !data.adapter || j.state !== "queued"} onRun={() => void run(`run:${j.id}`, async () => { await api.agentAReview.jobRun(fileId, j.id); return "실행을 시작했습니다. 끝나면 답과 수정안이 저장됩니다."; }, false)} />
                    {j.state === "running" ? <button type="button" className="vw-btn" disabled={busy} onClick={() => void run(`cancel:${j.id}`, async () => { await api.agentAReview.jobCancel(fileId, j.id); return "실행을 멈췄습니다. 결과 상태를 확인해 주세요."; }, false)}>실행 멈춤</button> : null}
                  </div>
                </div>
              ))}
            </section>
            <section className="aar-card" aria-label="수동 결과 가져오기">
              <header className="aar-card__head"><strong>수동 결과 가져오기</strong></header>
              <label className="aar-field">응답 JSON<textarea rows={5} value={importText} placeholder={'{"receipt_id":"…","answers":[],"proposals":[]}'} onChange={(e) => setImportText(e.target.value)} /></label>
              <div className="aar-actions">
                <GlassButton variant="glass" size="s" disabled={busy || !importText.trim()} onClick={() => void run("import-result", async () => {
                  let parsed: unknown;
                  try { parsed = JSON.parse(importText); } catch { throw new Error("JSON 으로 읽을 수 없습니다"); }
                  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("결과 JSON 은 객체여야 합니다");
                  await api.agentAReview.importResult(fileId, parsed as Record<string, unknown>);
                  setImportText("");
                  return "답과 수정안을 저장했습니다. 정본 반영은 ‘수정안’에서 고릅니다.";
                }, false)}>결과 가져오기</GlassButton>
              </div>
            </section>
          </>
        ) : null}

        {data && tab === "versions" ? (
          <ol className="aar-versions" aria-label="정본 판 이력">
            {[...data.versions].reverse().map((v, i) => (
              <li key={`${v.revision}:${i}`}>
                <span className="t-tabular">판 {v.revision}</span>
                <span>{v.cause}</span>
                <Time iso={v.at} />
              </li>
            ))}
          </ol>
        ) : null}

        {tab === "drafts" ? (
          recoveries.length === 0 ? (
            <p className="aar-note">다른 검토에 남은 초안이나 제출 기록이 없습니다.</p>
          ) : (
            <>
              <p className="aar-note">주석은 쓴 때의 본문에서만 열립니다. 최신 정본으로 옮기지 않습니다.</p>
              {recoveries.map((r) => (
                <section key={r.sessionId} className="aar-card">
                  <header className="aar-card__head">
                    <strong>{r.title || "이전 검토"}</strong>
                    <span className="aar-card__meta">{r.submitted ? "제출한 검토 기록" : "보내지 않은 초안"}</span>
                  </header>
                  <p className="aar-card__meta">
                    {r.artifactRevision === null ? "이전 문서" : `정본 판 ${r.artifactRevision}`} · 주석 {r.annotations}개{r.editedMarkdown ? " · 직접 편집 초안 포함" : ""}{r.attachments ? ` · 첨부 ${r.attachments}개` : ""} · <Time iso={r.createdAt} />
                  </p>
                  <div className="aar-actions">
                    <button type="button" className="vw-btn" onClick={() => { onOpenReview(r.sessionId); onClose(); }}>그 판에서 열기</button>
                  </div>
                </section>
              ))}
            </>
          )
        ) : null}
      </div>
    </Modal>
  );
}
