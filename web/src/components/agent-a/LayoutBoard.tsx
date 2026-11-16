// 순서·배치: 블록의 읽는 순서(위·아래)와, 배치 보드에서의 자리·크기.
// 원래 Agent-A 의 '배치 보드'를 IAMCEO 부품으로 옮긴 것이다. 배치 값은 블록마다 따로 저장하고(본문은 바뀌지 않는다), 좁은 화면에서는 순서만 바꾼다.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AgentABlock, AgentABlockLayout } from "@shared/agent-a";
import { GlassButton } from "../../glass";

export const KIND_LABEL: Record<string, string> = { markdown: "글", table: "표", mermaid: "도식", image: "그림" };
/** 배치를 정한 적 없는 블록의 기본 자리(원래 Agent-A 와 같다): 위에서 아래로 한 줄. */
export const defaultLayout = (index: number): AgentABlockLayout => ({ x: 0, y: index * 650, width: 620, height: 620 });
const MIN = 80;
const tidy = (l: AgentABlockLayout): AgentABlockLayout => ({ x: Math.max(0, Math.round(l.x)), y: Math.max(0, Math.round(l.y)), width: Math.max(MIN, Math.round(l.width)), height: Math.max(MIN, Math.round(l.height)) });
const same = (a: AgentABlockLayout, b: AgentABlockLayout) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const FIELDS: { key: keyof AgentABlockLayout; label: string }[] = [
  { key: "x", label: "가로 위치" },
  { key: "y", label: "세로 위치" },
  { key: "width", label: "너비" },
  { key: "height", label: "높이" },
];

export function LayoutBoard({ blocks, busy, board, onOrder, onLayout }: {
  /** 보관하지 않은 블록(읽는 순서대로). */
  blocks: AgentABlock[];
  busy: boolean;
  /** 보드를 그릴 만큼 넓은 화면인지. 좁으면 순서만 바꾼다. */
  board: boolean;
  onOrder: (ids: string[]) => void;
  onLayout: (blockId: string, layout: AgentABlockLayout) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  /** 끌거나 숫자를 고치는 중인 배치(아직 저장 전). */
  const [draft, setDraft] = useState<{ id: string; layout: AgentABlockLayout } | null>(null);
  /** 방금 저장한 배치의 그 전 값. 그 뒤 다른 배치 변경이 없을 때만 되돌린다. */
  const [undo, setUndo] = useState<{ id: string; before: AgentABlockLayout; after: AgentABlockLayout } | null>(null);
  const view = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(0);
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const measure = () => setViewWidth(el.clientWidth);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [board]);

  const layoutOf = (b: AgentABlock, index: number): AgentABlockLayout => (draft?.id === b.id ? draft.layout : b.layout ?? defaultLayout(index));
  const layouts = blocks.map(layoutOf);
  const size = { width: Math.max(660, ...layouts.map((l) => l.x + l.width + 30)), height: Math.max(500, ...layouts.map((l) => l.y + l.height + 30)) };
  // 한눈에 보이게 줄여 그린다(기본 블록 하나가 620×620 이라 그대로 그리면 한 화면에 하나만 보인다). 자리와 크기의 숫자는 줄이지 않은 값이다.
  const scale = Math.min(0.5, viewWidth > 0 ? viewWidth / size.width : 0.5);
  const picked = blocks.find((b) => b.id === selected) ?? null;
  const pickedIndex = picked ? blocks.indexOf(picked) : -1;
  const saved = (b: AgentABlock, index: number): AgentABlockLayout => b.layout ?? defaultLayout(index);

  const save = async (b: AgentABlock, index: number, next: AgentABlockLayout) => {
    const before = saved(b, index), after = tidy(next);
    if (same(before, after)) return setDraft(null);
    const ok = await onLayout(b.id, after);
    // 실패하면 끌던 자리를 그대로 둔다(다시 누르면 같은 요청으로 확인한다).
    if (!ok) return setDraft({ id: b.id, layout: after });
    setDraft(null);
    setUndo({ id: b.id, before, after });
  };

  // ---- 끌어서 옮기기·크기 바꾸기 ----
  const drag = useRef<{ id: string; mode: "move" | "size"; x: number; y: number; start: AgentABlockLayout; moved: boolean } | null>(null);
  const down = (e: ReactPointerEvent<HTMLElement>, b: AgentABlock, index: number, mode: "move" | "size") => {
    if (busy || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: b.id, mode, x: e.clientX, y: e.clientY, start: layoutOf(b, index), moved: false };
    setSelected(b.id);
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const dx = (e.clientX - d.x) / scale, dy = (e.clientY - d.y) / scale;
    if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 3) return;
    d.moved = true;
    setDraft({ id: d.id, layout: d.mode === "move" ? { ...d.start, x: Math.max(0, d.start.x + dx), y: Math.max(0, d.start.y + dy) } : { ...d.start, width: Math.max(MIN, d.start.width + dx), height: Math.max(MIN, d.start.height + dy) } });
  };
  const up = (e: ReactPointerEvent<HTMLElement>, b: AgentABlock, index: number) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d?.moved && draft?.id === b.id) void save(b, index, draft.layout);
  };

  const order = (index: number, by: -1 | 1) => {
    const ids = blocks.map((b) => b.id);
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to]!, ids[index]!];
    onOrder(ids);
  };
  const undoable = undo ? blocks.findIndex((b) => b.id === undo.id && b.layout !== null && same(b.layout, undo.after)) : -1;

  return (
    <div className="aar-layout">
      <section className="aar-card" aria-label="읽는 순서">
        <header className="aar-card__head"><strong>읽는 순서</strong><span className="aar-card__meta">본문은 이 순서로 이어집니다.</span></header>
        {blocks.length === 0 ? <p className="aar-card__meta">블록이 없습니다.</p> : null}
        <ol className="aar-order" aria-label="블록 순서">
          {blocks.map((b, i) => (
            <li key={b.id} data-block={b.id}>
              <span className="t-tabular aar-order__no">{i + 1}</span>
              <span className="aar-order__title">{b.title}</span>
              <span className="aa-tag">{KIND_LABEL[b.kind] ?? b.kind}</span>
              <button type="button" className="vw-btn" disabled={busy || i === 0} aria-label={`‘${b.title}’ 위로`} onClick={() => order(i, -1)}>위로</button>
              <button type="button" className="vw-btn" disabled={busy || i === blocks.length - 1} aria-label={`‘${b.title}’ 아래로`} onClick={() => order(i, 1)}>아래로</button>
            </li>
          ))}
        </ol>
      </section>
      {board ? (
        <section className="aar-card" aria-label="배치 보드">
          <header className="aar-card__head">
            <strong>배치 보드</strong>
            <span className="aar-card__meta">블록을 끌어 옮기고, 오른쪽 아래 모서리를 끌어 크기를 바꿉니다. 놓으면 저장합니다.</span>
          </header>
          <div ref={view} className="aar-board" role="group" aria-label="배치 보드의 블록">
            <div className="aar-board__stage" style={{ width: size.width * scale, height: size.height * scale }}>
              {blocks.map((b, i) => {
                const l = layouts[i]!;
                return (
                  <div key={b.id} className="aar-board__block" data-block={b.id} data-selected={selected === b.id ? "" : undefined} data-dirty={draft?.id === b.id ? "" : undefined}
                    style={{ left: l.x * scale, top: l.y * scale, width: l.width * scale, height: l.height * scale }}
                    onPointerDown={(e) => down(e, b, i, "move")} onPointerMove={move} onPointerUp={(e) => up(e, b, i)} onPointerCancel={() => { drag.current = null; setDraft(null); }}>
                    <button type="button" className="aar-board__name" aria-pressed={selected === b.id} aria-label={`블록 ${i + 1} ‘${b.title}’ 고르기`} onClick={() => setSelected(b.id)}>
                      <span className="t-tabular">{i + 1}</span> {b.title}
                    </button>
                    <span className="aar-board__kind">{KIND_LABEL[b.kind] ?? b.kind}{b.layout ? "" : " · 기본 자리"}</span>
                    <span className="aar-board__grip" aria-hidden="true" onPointerDown={(e) => down(e, b, i, "size")} onPointerMove={move} onPointerUp={(e) => up(e, b, i)} onPointerCancel={() => { drag.current = null; setDraft(null); }} />
                  </div>
                );
              })}
            </div>
          </div>
          {picked ? (
            <div className="aar-edit" aria-label="고른 블록의 배치">
              <p className="aar-card__meta">고른 블록: <span className="t-tabular">{pickedIndex + 1}</span> ‘{picked.title}’</p>
              <div className="aar-board__fields">
                {FIELDS.map((f) => (
                  <label key={f.key} className="aar-field">{f.label}
                    <input type="number" inputMode="numeric" min={f.key === "width" || f.key === "height" ? MIN : 0} max={100000} value={Math.round(layoutOf(picked, pickedIndex)[f.key])} disabled={busy}
                      onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setDraft({ id: picked.id, layout: { ...layoutOf(picked, pickedIndex), [f.key]: n } }); }} />
                  </label>
                ))}
              </div>
              <div className="aar-actions">
                <GlassButton variant="primary" size="s" disabled={busy || draft?.id !== picked.id || same(tidy(draft.layout), saved(picked, pickedIndex))} onClick={() => void save(picked, pickedIndex, draft!.layout)}>{busy ? "저장하는 중" : "배치 저장"}</GlassButton>
                {draft?.id === picked.id ? <GlassButton variant="ghost" size="s" disabled={busy} onClick={() => setDraft(null)}>고친 값 버리기</GlassButton> : null}
              </div>
            </div>
          ) : <p className="aar-card__meta">블록을 누르면 자리와 크기를 숫자로 고칠 수 있습니다.</p>}
          {undo && undoable >= 0 ? (
            <div className="aar-actions">
              <button type="button" className="vw-btn" disabled={busy} onClick={() => { const b = blocks[undoable]!; void onLayout(b.id, undo.before).then((ok) => ok && setUndo(null)); }}>방금 배치 되돌리기</button>
            </div>
          ) : null}
        </section>
      ) : (
        <p className="aar-note">배치 보드는 넓은 화면에서 씁니다. 여기서는 읽는 순서만 바꿉니다.</p>
      )}
    </div>
  );
}
