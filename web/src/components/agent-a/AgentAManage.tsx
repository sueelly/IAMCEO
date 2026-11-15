// 문서 관리: 이 문서의 모든 수정안 · 정본 블록과 이전 판 · 판 이력 · 다른 검토에 남은 초안과 기록.
// 정본을 바꾸는 일(저장·되살리기·직접 고치기)은 대표가 누를 때만 하고, 같은 누름을 다시 보내도 한 번만 반영된다(opId).
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentABlock, AgentAProposalStatus, AgentAReviewManage, AgentAReviewRecovery } from "@shared/agent-a";
import { GlassButton } from "../../glass";
import { api, errorText } from "../../lib/api";
import { PROPOSAL_LABEL, wordDiff } from "../../lib/agent-a-review";
import { newId } from "../../lib/store";
import { Modal, Time, useConfirmPress } from "../ui";
import { ProposalCard } from "./CommentPanel";

type Tab = "proposals" | "blocks" | "versions" | "drafts";
const TABS: { key: Tab; label: string }[] = [
  { key: "proposals", label: "수정안" },
  { key: "blocks", label: "정본" },
  { key: "versions", label: "판 이력" },
  { key: "drafts", label: "이전 초안·기록" },
];
const FILTERS: (AgentAProposalStatus | "all")[] = ["pending", "held", "conflict", "rejected", "applied", "all"];

function Restore({ disabled, revision, onRestore }: { disabled: boolean; revision: number; onRestore: () => void }) {
  const confirm = useConfirmPress();
  return (
    <button type="button" className="vw-btn" data-armed={confirm.armed ? "" : undefined} disabled={disabled} onClick={() => confirm.press(onRestore)}>
      {confirm.armed ? "한 번 더 눌러 되살리기" : `판 ${revision} 내용으로 되살리기`}
    </button>
  );
}

function BlockCard({ block, busy, onEdit, onRestore }: {
  block: AgentABlock; busy: boolean;
  onEdit: (input: { title: string; body: string }) => Promise<boolean>;
  onRestore: (historyRevision: number) => void;
}) {
  const [edit, setEdit] = useState<{ title: string; body: string; revision: number } | null>(null);
  const editable = !block.archived && block.kind === "markdown";
  return (
    <section className="aar-card" aria-label={`블록 ${block.title}`}>
      <header className="aar-card__head">
        <strong>{block.title}</strong>
        <span className="aar-card__meta t-tabular">판 {block.revision}{block.archived ? " · 보관됨" : ""}</span>
      </header>
      {edit ? (
        <div className="aar-edit">
          <label className="aar-field">제목<input value={edit.title} maxLength={500} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
          <label className="aar-field">본문<textarea rows={10} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
          {edit.revision !== block.revision ? <p className="aar-note" role="status">그사이 이 블록이 판 {block.revision}(으)로 바뀌었습니다. 고치던 글은 그대로 두었습니다. 닫고 다시 열어 최신 판에서 고쳐 주세요.</p> : null}
          <div className="aar-actions">
            <GlassButton variant="primary" size="s" disabled={busy || !edit.title.trim() || edit.revision !== block.revision} onClick={() => void onEdit({ title: edit.title, body: edit.body }).then((ok) => ok && setEdit(null))}>
              {busy ? "저장하는 중" : "정본에 저장"}
            </GlassButton>
            <GlassButton variant="ghost" size="s" disabled={busy} onClick={() => setEdit(null)}>고치기 그만</GlassButton>
          </div>
        </div>
      ) : (
        <div className="aar-actions">
          {editable ? <button type="button" className="vw-btn" disabled={busy} onClick={() => setEdit({ title: block.title, body: block.body, revision: block.revision })}>직접 고치기</button> : null}
        </div>
      )}
      {block.history.length ? (
        <details className="aar-fold">
          <summary>이전 판 <span className="t-tabular">{block.history.length}</span>개</summary>
          {[...block.history].reverse().map((h) => (
            <div key={h.revision} className="aar-history">
              <p className="aar-history__title">판 {h.revision} · {h.title}</p>
              <p className="aar-diff">
                {wordDiff(h.body, block.body).map((p, i) => (p.kind === "add" ? <ins key={i}>{p.text}</ins> : p.kind === "del" ? <del key={i}>{p.text}</del> : <span key={i}>{p.text}</span>))}
              </p>
              {block.archived ? null : <Restore disabled={busy || edit !== null} revision={h.revision} onRestore={() => onRestore(h.revision)} />}
            </div>
          ))}
        </details>
      ) : null}
    </section>
  );
}

export function AgentAManage({ fileId, open, recoveries, onClose, onChanged, onOpenReview }: {
  fileId: string;
  open: boolean;
  recoveries: AgentAReviewRecovery[];
  onClose: () => void;
  /** 정본이 바뀌었다. 본문을 최신 정본으로 다시 연다. */
  onChanged: (message: string) => void;
  onOpenReview: (sessionId: string) => void;
}) {
  const [data, setData] = useState<AgentAReviewManage | null>(null);
  const [tab, setTab] = useState<Tab>("proposals");
  const [filter, setFilter] = useState<AgentAProposalStatus | "all">("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
                  const r = await api.agentAReview.edit(fileId, { blockId: b.id, revision: b.revision, title: input.title, body: input.body, opId: id });
                  return `정본에 저장했습니다(판 ${r.artifactRevision}).`;
                }, true)}
                onRestore={(historyRevision) => void run(`restore:${b.id}:${b.revision}:${historyRevision}`, async (id) => {
                  const r = await api.agentAReview.restore(fileId, { blockId: b.id, revision: b.revision, historyRevision, opId: id });
                  return `판 ${historyRevision}의 내용을 새 판으로 되살렸습니다(판 ${r.artifactRevision}).`;
                }, true)}
              />
            ))}
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
