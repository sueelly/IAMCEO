// 빠른 라벨 고치기: 이 기기 브라우저에 기억하는 라벨 목록(이모지·이름·색·지침)을 고친다.
import { useEffect, useState } from "react";
import { GlassButton } from "../../glass";
import { DEFAULT_LABELS, LABEL_TONES, MAX_LABELS, cleanLabel, labelText, type QuickLabel } from "../../lib/agent-a-labels";
import { newId } from "../../lib/store";
import { Modal, useConfirmPress } from "../ui";

export function LabelEditor({ open, labels, onClose, onSave }: { open: boolean; labels: QuickLabel[]; onClose: () => void; /** null 이면 기본 라벨로 되돌린다. */ onSave: (next: QuickLabel[] | null) => void }) {
  const [rows, setRows] = useState<QuickLabel[]>(labels);
  const reset = useConfirmPress();
  useEffect(() => {
    if (open) setRows(labels);
  }, [open, labels]);
  const change = (id: string, patch: Partial<QuickLabel>) => setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  // 저장할 때 다듬는다(빈 이름은 뺀다). 쓰는 동안에는 쓴 그대로 둔다.
  const cleaned = rows.flatMap((r) => cleanLabel(r) ?? []);
  return (
    <Modal open={open} onClose={onClose} title="빠른 라벨 고치기">
      <div className="aar-manage">
        <p className="aar-note">고른 글에 한 번 눌러 붙이는 라벨입니다. 이 기기 브라우저에만 기억합니다. 지침은 검토 제출 때 그 라벨과 함께 넘어갑니다.</p>
        {rows.map((r, i) => (
          <section key={r.id} className="aar-card" aria-label={`라벨 ${i + 1}`} data-label={r.id}>
            <div className="aar-labelrow">
              <label className="aar-field">이모지<input value={r.emoji} maxLength={8} onChange={(e) => change(r.id, { emoji: e.target.value })} /></label>
              <label className="aar-field">이름<input value={r.text} maxLength={60} onChange={(e) => change(r.id, { text: e.target.value })} /></label>
              <label className="aar-field">색
                <select value={r.tone} onChange={(e) => change(r.id, { tone: e.target.value as QuickLabel["tone"] })}>
                  {LABEL_TONES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </label>
            </div>
            <label className="aar-field">지침(선택)<input value={r.tip ?? ""} maxLength={300} placeholder="이 라벨을 받은 쪽에 전할 말" onChange={(e) => change(r.id, { tip: e.target.value })} /></label>
            <div className="aar-actions">
              <span className="aar-label" data-tone={r.tone}>{labelText(r) || "이름을 적어 주세요"}</span>
              <button type="button" className="vw-btn" onClick={() => setRows((cur) => cur.filter((x) => x.id !== r.id))}>이 라벨 빼기</button>
            </div>
          </section>
        ))}
        <div className="aar-actions">
          <button type="button" className="vw-btn" disabled={rows.length >= MAX_LABELS} onClick={() => setRows((cur) => [...cur, { id: `label-${newId()}`.slice(0, 60), emoji: "🏷️", text: "", tone: "yellow" }])}>라벨 더하기</button>
          <span className="aar-card__meta">{rows.length} / {MAX_LABELS}</span>
        </div>
        <div className="aar-actions">
          <GlassButton variant="primary" size="s" disabled={cleaned.length === 0} onClick={() => { onSave(cleaned); onClose(); }}>라벨 저장</GlassButton>
          <button type="button" className="vw-btn" data-armed={reset.armed ? "" : undefined} onClick={() => reset.press(() => { setRows(DEFAULT_LABELS); onSave(null); onClose(); })}>
            {reset.armed ? "한 번 더 눌러 되돌리기" : "기본 라벨로 되돌리기"}
          </button>
          <GlassButton variant="ghost" size="s" onClick={onClose}>닫기</GlassButton>
        </div>
      </div>
    </Modal>
  );
}
