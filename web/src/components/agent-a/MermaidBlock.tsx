// 본문의 도식(Mermaid) 블록. 그림으로 그리고, 원문도 볼 수 있다. 그리지 못하면 원문을 글로 보인다.
// 그림은 <img> 로만 보인다(web/src/lib/mermaid.ts 의 안전 설명). 도식의 글은 글자로만 다루고 HTML 로 해석하지 않는다.
// 도식의 한 부분(노드·선·묶음)을 누르면 그 부분에, 빈 자리를 누르면 도식 전체에 댓글을 단다(원래 Agent-A 화면의 도식 댓글).
// 그림 안의 요소는 누를 수 없으므로, 그리는 칸이 돌려준 부분의 자리에 투명한 단추를 겹쳐 놓는다. 댓글이 달린 부분은 번호 표시로 보인다.
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import type { AgentAReviewDiagramAnchor } from "@shared/agent-a";
import { anchorFor, anchorText, findPart, partKey, pickable, type DiagramBox, type DiagramPart } from "../../lib/agent-a-diagram";
import { renderDiagram, type DiagramImage } from "../../lib/mermaid";

/** 이 도식에 달린 댓글 하나의 표시. */
export interface DiagramMark {
  threadId: string;
  anchor: AgentAReviewDiagramAnchor;
  done: boolean;
}

/** 그려진 도식의 갈래와 부분. 댓글이 어느 도식의 것인지 가리는 데 쓴다. */
export type DiagramDrawn = Pick<DiagramImage, "family" | "parts">;

const KIND_WORD: Record<DiagramPart["kind"], string> = { node: "노드", edge: "선", cluster: "묶음" };
/** 겹칠 때 위에 오는 차례: 묶음 < 선 < 노드(작은 부분이 큰 부분에 가리지 않는다). */
const ORDER: Record<DiagramPart["kind"], number> = { cluster: 0, edge: 1, node: 2 };
const WHOLE: DiagramBox = { x: 0, y: 0, w: 1, h: 1 };
const pct = (n: number) => `${Math.round(n * 100_000) / 1_000}%`;
const boxStyle = (b: DiagramBox): CSSProperties => ({ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) });

export function MermaidBlock({ code, line, marks, active, draft, canComment, onPick, onOpen, onDrawn }: {
  code: string;
  /** ```mermaid 줄의 문서 줄 번호. 도식 글의 k 번째 줄은 문서의 line + k 번째 줄이다. */
  line: number;
  marks: DiagramMark[];
  active: string | null;
  /** 지금 댓글을 쓰고 있는 자리(이 도식의 것일 때). */
  draft: AgentAReviewDiagramAnchor | null;
  /** 새 댓글을 달 수 있는지. false 면 누를 부분을 놓지 않는다(달린 표시는 그대로 읽는다). */
  canComment: boolean;
  onPick: (anchor: AgentAReviewDiagramAnchor) => void;
  onOpen: (threadId: string) => void;
  /** 그려졌으면 갈래와 부분, 그리는 중이면 undefined, 그리지 못했으면 null. */
  onDrawn: (drawn: DiagramDrawn | null | undefined) => void;
}) {
  const [image, setImage] = useState<{ url: string; width: number; height: number; drawn: DiagramDrawn } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    let made: string | null = null;
    setImage(null);
    setError(null);
    onDrawn(undefined);
    if (!code.trim()) {
      setError("도식 글이 비어 있습니다");
      onDrawn(null);
      return;
    }
    renderDiagram(code).then(
      (d) => {
        if (stopped) return;
        made = URL.createObjectURL(new Blob([d.svg], { type: "image/svg+xml" }));
        const drawn = { family: d.family, parts: d.parts };
        setImage({ url: made, width: d.width, height: d.height, drawn });
        onDrawn(drawn);
      },
      (e) => {
        if (stopped) return;
        setError((e instanceof Error && e.message ? e.message : "알 수 없는 까닭").split("\n")[0]!.slice(0, 200));
        onDrawn(null);
      },
    );
    return () => {
      stopped = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [code, attempt, onDrawn]);

  const parts = image?.drawn.parts;
  const family = image?.drawn.family;
  /** 누르는 자리들. 도식 글의 문장에서 찾을 수 있는 부분만 낸다(그 밖의 자리는 도식 전체에 단다). 겹치면 노드가 선 위에, 선이 묶음 위에 온다. */
  const hits = useMemo(() => (parts && family ? pickable(family, parts, code) : [])
    .map((part, at) => ({ part, at }))
    .sort((a, b) => ORDER[a.part.kind] - ORDER[b.part.kind] || a.at - b.at)
    .flatMap(({ part, at }) => part.hits.map((box, i) => ({ part, box, key: `${at}:${i}`, first: i === 0 }))), [parts, family, code]);
  /** 자리(부분의 둘레나 도식 전체)를 찾는다. 다시 그린 도식에 그 부분이 없으면 null(표시 없이 댓글 목록에만 남는다). */
  const place = (anchor: AgentAReviewDiagramAnchor): DiagramBox | null => {
    const found = findPart(parts ?? [], anchor);
    return found === "whole" ? WHOLE : found ? found.box : null;
  };
  const placed = marks.flatMap((m, i) => {
    const box = place(m.anchor);
    return box ? [{ ...m, no: i + 1, box, whole: box === WHOLE }] : [];
  });
  /** 같은 자리에 달린 댓글들의 번호는 옆으로 나란히 둔다. */
  const nth = (i: number) => placed.slice(0, i).filter((p) => p.box === placed[i]!.box).length;
  const draftBox = draft ? place(draft) : null;
  const drawn = image !== null && !source;
  const pick = (e: MouseEvent, part: DiagramPart | null) => {
    e.stopPropagation();
    if (image) onPick(anchorFor(image.drawn.family, part, code, line));
  };

  return (
    <figure className="aar-diagram" data-state={image ? "drawn" : error ? "failed" : "drawing"}>
      <figcaption className="aar-diagram__cap">
        <span>{drawn ? "도식" : "도식 원문"}</span>
        {image ? <button type="button" className="aa-link" onClick={() => setSource((v) => !v)}>{source ? "그림 보기" : "원문 보기"}</button> : null}
        {error ? <button type="button" className="aa-link" onClick={() => setAttempt((n) => n + 1)}>다시 그리기</button> : null}
      </figcaption>
      {drawn ? (
        <div className="aar-diagram__frame">
          <img className="aar-diagram__img" src={image.url} width={image.width} height={image.height} alt="도식" draggable={false} />
          <div className="aar-diagram__layer" data-pick={canComment ? "" : undefined} onClick={canComment ? (e) => e.target === e.currentTarget && pick(e, null) : undefined}>
            {canComment ? hits.map(({ part, box, key, first }) => {
              const text = anchorText(part);
              return (
                <button key={key} type="button" className="aar-diagram__part" data-kind={part.kind} data-part={partKey(part)} style={boxStyle(box)} title={text}
                  aria-label={first ? `${KIND_WORD[part.kind]} ‘${text}’에 댓글 달기` : undefined} aria-hidden={first ? undefined : true} tabIndex={first ? 0 : -1} onClick={(e) => pick(e, part)} />
              );
            }) : null}
            {placed.map((m, i) => (
              <span key={m.threadId} className="aar-diagram__ring" style={boxStyle(m.box)} data-whole={m.whole ? "" : undefined} data-active={m.threadId === active ? "" : undefined} data-done={m.done ? "" : undefined}>
                <button type="button" className="aar-diagram__mark" style={{ "--nth": nth(i) } as CSSProperties} data-active={m.threadId === active ? "" : undefined} data-done={m.done ? "" : undefined}
                  aria-label={`도식 댓글 ${m.no} 열기`} onClick={(e) => { e.stopPropagation(); onOpen(m.threadId); }}>
                  {m.no}
                </button>
              </span>
            ))}
            {draftBox ? <span className="aar-diagram__draft" style={boxStyle(draftBox)} data-whole={draftBox === WHOLE ? "" : undefined} /> : null}
          </div>
        </div>
      ) : <pre className="aar-diagram__code">{code}</pre>}
      {error ? <p className="aar-note" role="status">도식을 그리지 못해 원문을 보입니다: {error}</p> : !image ? <p className="aar-note" role="status">도식을 그리는 중…</p> : null}
    </figure>
  );
}
