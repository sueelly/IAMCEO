// Agent-A 문서 본문. IAMCEO 의 마크다운 보기로 그리고, 글을 끌어 고르거나(끌기) 문단·항목을 눌러 고른다(요소 지정). 그림은 영역을 끌어 질문한다.
// 고른 뒤의 동작은 모드가 정한다: 표시(댓글·삭제 표시·묻기 중 고름) · 댓글(바로 댓글 쓰기) · 삭제 표시(바로 삭제 표시).
// 댓글·삭제 표시가 달린 문장은 CSS 강조(Highlight)로만 칠한다: 본문 DOM 을 바꾸지 않으므로 고르기·복사가 그대로다.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AgentAReviewImage, AgentAReviewImageRegion } from "@shared/agent-a";
import { api, fetchAttachment } from "../../lib/api";
import { THUMBS_UP, labelText, type QuickLabel } from "../../lib/agent-a-labels";
import { imageFor, regionOf, regionStyle, splitDoc, squash, type ReviewThread } from "../../lib/agent-a-review";
import { Markdown } from "../ui";
import { MermaidBlock } from "./MermaidBlock";

/** 고른 뒤의 동작. 표시: 뜨는 단추에서 고름 · 댓글: 바로 댓글 쓰기 · 삭제 표시: 바로 삭제 표시를 남김 · 라벨: 바로 라벨 목록을 띄움. */
export type ReviewMode = "markup" | "comment" | "redline" | "label";
/** 고르는 방법. 끌기: 글을 끌어 고름 · 요소 지정: 문단·항목·제목을 눌러 통째로 고름. */
export type ReviewInput = "drag" | "pinpoint";
const PINPOINT = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th";

const BLOCK = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "TR", "TD", "TH", "BLOCKQUOTE", "PRE", "SECTION", "FIGURE", "HR", "BR"]);

interface TextIndex {
  text: string;
  at: { node: Text; offset: number }[];
}

/** 본문의 글자를 '빈칸 뭉치 → 빈칸 하나'로 이어 붙이고, 글자마다 원래 자리를 적어 둔다. 문단이 바뀌는 곳도 빈칸으로 친다. */
function indexText(root: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const at: TextIndex["at"] = [];
  let text = "";
  let space = true;
  let lastBlock: Element | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    let block: Element | null = node.parentElement;
    while (block && block !== root && !BLOCK.has(block.tagName)) block = block.parentElement;
    if (block !== lastBlock && !space) {
      text += " ";
      at.push({ node, offset: 0 });
      space = true;
    }
    lastBlock = block;
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      const ws = /\s/.test(data[i]!);
      if (ws && space) continue;
      text += ws ? " " : data[i];
      at.push({ node, offset: i });
      space = ws;
    }
  }
  return { text, at };
}

function locate(index: TextIndex, quote: string): Range | null {
  const want = squash(quote);
  if (!want) return null;
  const start = index.text.indexOf(want);
  if (start < 0) return null;
  const a = index.at[start], b = index.at[start + want.length - 1];
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, Math.min(b.offset + 1, b.node.data.length));
  return range;
}

/** 누른 자리의 글자 위치. 브라우저마다 이름이 다르다. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) return { node: pos.offsetNode, offset: pos.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

const canHighlight = (): boolean => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";

export interface RegionMark {
  threadId: string;
  region: AgentAReviewImageRegion;
  done: boolean;
}

function ReviewImage({ fileId, session, image, alt, marks, active, draft, canAsk, onDraw, onOpen }: {
  fileId: string;
  session: string;
  image: AgentAReviewImage;
  alt: string;
  marks: RegionMark[];
  active: string | null;
  /** 지금 질문을 쓰고 있는 영역(이 그림의 것일 때). */
  draft: AgentAReviewImageRegion | null;
  canAsk: boolean;
  onDraw: (region: AgentAReviewImageRegion) => void;
  onOpen: (threadId: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stopped = false;
    let made: string | null = null;
    setUrl(null);
    setFailed(false);
    fetchAttachment({ url: api.agentAReview.imageUrl(fileId, session, image.src) })
      .then((res) => res.blob())
      .then((blob) => {
        if (stopped) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => !stopped && setFailed(true));
    return () => {
      stopped = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [fileId, session, image.src]);
  // 질문을 보냈거나 그만두면(초안이 사라지면) 그리기도 끝난다
  useEffect(() => {
    if (!draft) setDrag(null);
  }, [draft]);

  const point = (e: ReactPointerEvent): { x: number; y: number } => {
    const box = layerRef.current!.getBoundingClientRect();
    return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height };
  };
  const down = (e: ReactPointerEvent) => {
    if (!drawing || e.button !== 0) return;
    e.preventDefault();
    layerRef.current!.setPointerCapture(e.pointerId);
    const p = point(e);
    setDrag({ a: p, b: p });
  };
  const move = (e: ReactPointerEvent) => {
    if (!drawing || !drag || !layerRef.current?.hasPointerCapture(e.pointerId)) return;
    setDrag({ a: drag.a, b: point(e) });
  };
  const up = (e: ReactPointerEvent) => {
    if (!drawing || !drag || !layerRef.current?.hasPointerCapture(e.pointerId)) return;
    layerRef.current.releasePointerCapture(e.pointerId);
    const region = regionOf(image, drag.a, point(e));
    setDrawing(false);
    // 점만 찍었으면(너무 작으면) 그리지 않은 것으로 친다
    if (!region || region.box.w < 4 || region.box.h < 4) {
      setDrag(null);
      return;
    }
    onDraw(region);
  };
  const shown = draft ?? (drag ? regionOf(image, drag.a, drag.b) : null);

  return (
    <figure className="aar-fig" data-drawing={drawing ? "" : undefined}>
      <div className="aar-fig__frame" style={{ aspectRatio: `${image.width} / ${image.height}` }}>
        {url ? <img className="aar-fig__img" src={url} alt={alt} draggable={false} /> : <p className="aar-fig__wait">{failed ? "그림을 불러오지 못했습니다" : "그림을 여는 중…"}</p>}
        <div ref={layerRef} className="aar-fig__layer" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { setDrag(null); setDrawing(false); }}>
          {marks.map((m, i) => (
            <button key={m.threadId} type="button" className="aar-fig__mark" style={regionStyle(m.region)} data-active={m.threadId === active ? "" : undefined} data-done={m.done ? "" : undefined}
              aria-label={`그림 영역 댓글 ${i + 1} 열기`} onClick={() => onOpen(m.threadId)} disabled={drawing}>
              <span aria-hidden="true">{i + 1}</span>
            </button>
          ))}
          {shown ? <span className="aar-fig__draft" style={regionStyle(shown)} /> : null}
        </div>
      </div>
      <figcaption className="aar-fig__cap">
        <span className="aar-fig__alt">{alt}</span>
        {canAsk && url ? (
          <button type="button" className="vw-btn" aria-pressed={drawing} onClick={() => { setDrag(null); setDrawing((v) => !v); }}>
            {drawing ? "영역 고르기 그만" : "영역 골라 질문"}
          </button>
        ) : null}
      </figcaption>
      {drawing ? <p className="aar-fig__hint" role="status">그림 위에서 끌어 영역을 고르세요.</p> : null}
    </figure>
  );
}

const Chunk = memo(function Chunk({ text }: { text: string }) {
  return <Markdown text={text} className="aar-md" />;
});

export interface ReviewDocumentProps {
  fileId: string;
  session: string;
  markdown: string;
  images: AgentAReviewImage[];
  threads: ReviewThread[];
  activeThread: string | null;
  /** 새 댓글을 달 수 있는지(과거 판 보기·닫힌 검토에서는 false). */
  canComment: boolean;
  regionDraft: AgentAReviewImageRegion | null;
  mode: ReviewMode;
  input: ReviewInput;
  onQuote: (quote: string) => void;
  /** 고른 글에 삭제 표시를 남긴다. */
  onDelete: (quote: string) => void;
  /** 고른 글과 함께 문서에 묻는다(문서 대화). 없으면 '묻기' 단추를 보이지 않는다. */
  onAsk?: (quote: string) => void;
  onRegion: (region: AgentAReviewImageRegion) => void;
  onOpenThread: (threadId: string) => void;
  /** 빠른 라벨 목록과 붙이기. 없으면 라벨 단추를 보이지 않는다. */
  labels?: readonly QuickLabel[];
  onLabel?: (quote: string, label: QuickLabel) => void;
  onEditLabels?: () => void;
}

export function ReviewDocument({ fileId, session, markdown, images, threads, activeThread, canComment, regionDraft, mode, input, onQuote, onDelete, onAsk, onRegion, onOpenThread, labels, onLabel, onEditLabels }: ReviewDocumentProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ranges = useRef(new Map<string, Range>());
  /** 고른 글과 뜨는 단추의 자리. menu 면 단추 대신 라벨 목록을 보인다. */
  const [pick, setPick] = useState<{ quote: string; left: number; top: number; menu?: boolean } | null>(null);
  const labelList = useMemo(() => (onLabel ? [THUMBS_UP, ...(labels ?? [])] : []), [labels, onLabel]);
  const parts = useMemo(() => splitDoc(markdown), [markdown]);
  const quoteThreads = useMemo(() => threads.filter((t) => t.root.quote && !t.root.region && t.root.kind !== "global"), [threads]);
  /** 고른 글로 할 일. 표시 모드는 단추를 띄우고, 나머지 모드는 바로 한다(pointer 로 고른 때만. 자판으로 고르는 중에는 단추를 띄운다). */
  const act = useCallback((quote: string, at: { left: number; top: number }, direct: boolean) => {
    if (direct && mode === "comment") return onQuote(quote);
    if (direct && mode === "redline") {
      window.getSelection()?.removeAllRanges();
      return onDelete(quote);
    }
    setPick({ quote, ...at, menu: mode === "label" && Boolean(onLabel) });
  }, [mode, onQuote, onDelete, onLabel]);
  const applyLabel = useCallback((quote: string, label: QuickLabel) => {
    window.getSelection()?.removeAllRanges();
    setPick(null);
    onLabel?.(quote, label);
  }, [onLabel]);
  // 글을 고른 채 ⌥(Alt)+숫자를 누르면 그 차례의 라벨을 바로 붙인다(1 은 맨 위의 '좋아요').
  useEffect(() => {
    if (!pick || !labelList.length) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const m = /^Digit([1-9])$/.exec(e.code);
      const label = m ? labelList[Number(m[1]) - 1] : undefined;
      if (!label) return;
      e.preventDefault();
      applyLabel(pick.quote, label);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pick, labelList, applyLabel]);
  const marksBy = useMemo(() => {
    const by = new Map<string, RegionMark[]>();
    for (const t of threads) {
      const region = t.root.region;
      if (!region) continue;
      const key = `${region.src}\n${region.sourceLine ?? ""}`;
      by.set(key, [...(by.get(key) ?? []), { threadId: t.root.id, region, done: t.done }]);
    }
    return by;
  }, [threads]);

  // 댓글이 달린 문장을 칠한다. 본문이나 댓글 목록이 바뀔 때만 다시 찾는다.
  const quoteKey = quoteThreads.map((t) => `${t.root.id}:${t.done ? 1 : 0}:${t.root.kind}:${t.root.quote.length}`).join("|");
  useLayoutEffect(() => {
    const root = rootRef.current;
    ranges.current = new Map();
    if (!root) return;
    const index = indexText(root);
    for (const t of quoteThreads) {
      const range = locate(index, t.root.quote);
      if (range) ranges.current.set(t.root.id, range);
    }
    if (!canHighlight()) return;
    const open: Range[] = [], done: Range[] = [], deletion: Range[] = [];
    for (const t of quoteThreads) {
      const range = ranges.current.get(t.root.id);
      if (range) (t.done ? done : t.root.kind === "deletion" ? deletion : open).push(range);
    }
    CSS.highlights.set("aa-quote", new Highlight(...open));
    CSS.highlights.set("aa-quote-done", new Highlight(...done));
    CSS.highlights.set("aa-deletion", new Highlight(...deletion));
    return () => {
      CSS.highlights.delete("aa-quote");
      CSS.highlights.delete("aa-quote-done");
      CSS.highlights.delete("aa-deletion");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, quoteKey]);
  useLayoutEffect(() => {
    if (!canHighlight()) return;
    const range = activeThread ? ranges.current.get(activeThread) : undefined;
    if (range) CSS.highlights.set("aa-quote-active", new Highlight(range));
    else CSS.highlights.delete("aa-quote-active");
    return () => void CSS.highlights.delete("aa-quote-active");
  }, [activeThread, markdown, quoteKey]);

  // 댓글을 고르면 그 문장이 보이게 옮긴다
  useEffect(() => {
    const range = activeThread ? ranges.current.get(activeThread) : undefined;
    const el = range?.startContainer.parentElement;
    if (!el) return;
    const box = range!.getBoundingClientRect();
    const view = el.closest<HTMLElement>(".aar-scroll")?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
    if (box.top < view.top + 8 || box.bottom > view.bottom - 8) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeThread]);

  // 글을 끌어 고르면 그 끝에 '댓글' 단추를 띄운다. 끄는 동안에는 띄우지 않는다.
  const dragging = useRef(false);
  /** 요소 지정으로 고른 직후의 선택 바뀜은 이미 처리했다. */
  const pinned = useRef(false);
  const readSelection = useCallback((direct: boolean) => {
    const root = rootRef.current;
    const sel = window.getSelection();
    if (!root || !canComment || !sel || sel.isCollapsed || sel.rangeCount === 0) return setPick(null);
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return setPick(null);
    const quote = sel.toString().trim();
    if (!quote) return setPick(null);
    const rects = range.getClientRects();
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    act(quote, { left: Math.min(Math.max(last.right - host.left, 44), host.width - 44), top: last.bottom - host.top + 6 }, direct);
  }, [canComment, act]);
  useEffect(() => {
    const onChange = () => {
      if (pinned.current) return;
      if (!dragging.current) readSelection(false);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      // 고르기가 끝난 뒤의 선택을 읽는다(일부 브라우저는 pointerup 뒤에 선택을 마무리한다)
      setTimeout(() => !pinned.current && readSelection(true), 0);
    };
    document.addEventListener("selectionchange", onChange);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [readSelection]);

  // 뜨는 단추 묶음의 반 폭(가운데 맞춤이라 화면 밖으로 나가지 않게 자리를 잡는 데 쓴다). 단추 수는 모드가 정한다.
  const pickHalf = pick?.menu ? 118 : mode === "markup" ? (onAsk ? 118 : 86) + (onLabel ? 30 : 0) : mode === "redline" ? 56 : 44;
  const onClick = (e: { clientX: number; clientY: number; target: EventTarget }) => {
    if (!(e.target instanceof Element) || e.target.closest("a, button, .aar-fig")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const caret = caretAt(e.clientX, e.clientY);
    if (!caret) return;
    for (const [id, range] of ranges.current) {
      try {
        if (range.isPointInRange(caret.node, caret.offset)) return onOpenThread(id);
      } catch {
        // 본문이 다시 그려져 범위가 끊긴 경우: 다음 그리기에서 다시 찾는다
      }
    }
    // 요소 지정: 누른 문단·항목·제목을 통째로 고른다.
    const root = rootRef.current;
    if (input !== "pinpoint" || !canComment || !root) return;
    const el = e.target.closest<HTMLElement>(PINPOINT);
    if (!el || !root.contains(el) || !el.closest(".aar-md")) return;
    const quote = squash(el.innerText ?? el.textContent ?? "").slice(0, 60_000);
    if (!quote) return;
    pinned.current = true;
    sel?.selectAllChildren(el);
    setTimeout(() => { pinned.current = false; }, 0);
    const box = el.getBoundingClientRect(), host = root.getBoundingClientRect();
    act(quote, { left: Math.min(Math.max(box.left - host.left + 44, 44), host.width - 44), top: box.bottom - host.top + 6 }, true);
  };

  return (
    <div ref={rootRef} className="aar-doc" data-input={canComment ? input : undefined} data-mode={mode} onPointerDown={() => { dragging.current = true; setPick(null); }} onClick={onClick}>
      {parts.map((part, i) => {
        if (part.kind === "markdown") return <Chunk key={`m${i}`} text={part.text} />;
        if (part.kind === "mermaid") return <MermaidBlock key={`d${i}`} code={part.code} />;
        const image = imageFor(images, part.src, part.line);
        if (!image) return <p key={`i${i}`} className="aar-fig__wait">그림 정보를 찾지 못했습니다: {part.alt}</p>;
        const marks = marksBy.get(`${image.src}\n${image.sourceLine}`) ?? marksBy.get(`${image.src}\n`) ?? [];
        const draft = regionDraft && regionDraft.src === image.src && (regionDraft.sourceLine ?? image.sourceLine) === image.sourceLine ? regionDraft : null;
        return <ReviewImage key={`i${i}`} fileId={fileId} session={session} image={image} alt={part.alt} marks={marks} active={activeThread} draft={draft} canAsk={canComment} onDraw={onRegion} onOpen={onOpenThread} />;
      })}
      {pick?.menu ? (
        <span className="aar-picks aar-picks--menu" role="menu" aria-label="빠른 라벨" style={{ left: Math.min(Math.max(pick.left, pickHalf), Math.max(pickHalf, (rootRef.current?.clientWidth ?? 0) - pickHalf)), top: pick.top }} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onClick={(e) => e.stopPropagation()}>
          {labelList.map((label, i) => (
            <button key={label.id} type="button" role="menuitem" className="aar-labelitem" title={label.tip} onClick={() => applyLabel(pick.quote, label)}>
              <span className="aar-label" data-tone={label.tone}>{labelText(label)}</span>
              {i < 9 ? <kbd className="aar-labelitem__key" aria-hidden="true">⌥{i + 1}</kbd> : null}
            </button>
          ))}
          {onEditLabels ? <button type="button" role="menuitem" className="aar-labelitem aar-labelitem--edit" onClick={() => { setPick(null); onEditLabels(); }}>라벨 고치기…</button> : null}
        </span>
      ) : pick ? (
        <span className="aar-picks" role="group" aria-label="고른 글로 할 일" style={{ left: Math.min(Math.max(pick.left, pickHalf), Math.max(pickHalf, (rootRef.current?.clientWidth ?? 0) - pickHalf)), top: pick.top }} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onClick={(e) => e.stopPropagation()}>
          {mode !== "redline" && mode !== "label" ? <button type="button" className="aar-pick" onClick={() => { onQuote(pick.quote); setPick(null); }}>댓글</button> : null}
          {(mode === "markup" || mode === "label") && onLabel ? <button type="button" className="aar-pick2" aria-haspopup="menu" onClick={() => setPick({ ...pick, menu: true })}>라벨</button> : null}
          {mode === "markup" || mode === "redline" ? <button type="button" className="aar-pick2" data-tone="danger" onClick={() => { window.getSelection()?.removeAllRanges(); onDelete(pick.quote); setPick(null); }}>삭제 표시</button> : null}
          {mode === "markup" && onAsk ? <button type="button" className="aar-pick2" onClick={() => { onAsk(pick.quote); setPick(null); }}>묻기</button> : null}
        </span>
      ) : null}
    </div>
  );
}
