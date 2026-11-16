// 그림 위에 그리기: 붙일 그림에 펜·화살표·동그라미로 표시를 남긴다. 저장하면 표시가 든 새 그림(PNG)이 되고, 원래 그림은 그대로다.
// 원래 Agent-A 화면의 그림 주석 도구(펜·화살표·동그라미, 다섯 색, 되돌리기)를 IAMCEO 부품으로 옮긴 것이다.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { GlassButton } from "../../glass";
import { Modal } from "../ui";

type Tool = "pen" | "arrow" | "circle";
interface Point { x: number; y: number }
export interface Stroke { tool: Tool; color: string; size: number; points: Point[] }
const TOOLS: { key: Tool; label: string }[] = [{ key: "pen", label: "펜" }, { key: "arrow", label: "화살표" }, { key: "circle", label: "동그라미" }];
const COLORS: { value: string; label: string }[] = [{ value: "#ef4444", label: "빨강" }, { value: "#eab308", label: "노랑" }, { value: "#22c55e", label: "초록" }, { value: "#3b82f6", label: "파랑" }, { value: "#ffffff", label: "하양" }];
const SIZES: { value: number; label: string }[] = [{ value: 3, label: "가늘게" }, { value: 6, label: "보통" }, { value: 12, label: "굵게" }];
/** 그리는 판의 긴 변(픽셀). 더 큰 그림은 줄여서 그린다. */
const MAX_SIDE = 2400;
const MAX_BYTES = 4 * 1024 * 1024;

/** 표시 하나를 그린다. 펜은 이어진 선, 화살표는 처음과 끝을 잇는 선과 촉, 동그라미는 처음과 끝을 모서리로 하는 타원이다. */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  const a = s.points[0], b = s.points[s.points.length - 1];
  if (!a || !b) return;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (s.tool === "pen") {
    ctx.moveTo(a.x, a.y);
    for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
    if (s.points.length === 1) ctx.lineTo(a.x + 0.01, a.y);
    ctx.stroke();
  } else if (s.tool === "arrow") {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const angle = Math.atan2(b.y - a.y, b.x - a.x), head = Math.max(10, s.size * 3.5);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function ImageDraw({ source, onClose, onSave }: {
  /** 그릴 그림(이 브라우저 안의 주소)과 이름. null 이면 닫혀 있다. */
  source: { url: string; name: string } | null;
  onClose: () => void;
  /** 표시가 든 새 그림. 올리고 바꿔 끼우는 일은 부른 쪽이 한다. 실패하면 false 를 돌려주고, 창은 닫히지 않는다. */
  onSave: (file: File) => Promise<boolean>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const current = useRef<Stroke | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]!.value);
  const [size, setSize] = useState(6);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [undone, setUndone] = useState<Stroke[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = source?.url ?? null;
  const sourceName = source?.name ?? "";

  useEffect(() => {
    setReady(false);
    setFailed(false);
    setStrokes([]);
    setUndone([]);
    setError(null);
    image.current = null;
    current.current = null;
    if (!url) return;
    setName(sourceName.replace(/\.[^.]+$/, "").slice(0, 150));
    let stopped = false;
    const img = new Image();
    img.onload = () => {
      if (stopped) return;
      image.current = img;
      setReady(true);
    };
    img.onerror = () => !stopped && setFailed(true);
    img.src = url;
    return () => {
      stopped = true;
    };
  }, [url, sourceName]);

  const redraw = useCallback((extra?: Stroke | null) => {
    const c = canvas.current, img = image.current;
    const ctx = c?.getContext("2d");
    if (!c || !img || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    for (const s of strokes) drawStroke(ctx, s);
    if (extra) drawStroke(ctx, extra);
  }, [strokes]);
  useEffect(() => {
    const c = canvas.current, img = image.current;
    if (!ready || !c || !img) return;
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    redraw();
  }, [ready, redraw]);

  /** 화면의 한 점을 그리는 판의 픽셀로. 선 굵기도 같은 비율로 키운다(화면에서 본 굵기가 그대로 남게). */
  const ratio = (): number => {
    const c = canvas.current!;
    const box = c.getBoundingClientRect();
    return box.width > 0 ? c.width / box.width : 1;
  };
  const point = (e: ReactPointerEvent): Point => {
    const box = canvas.current!.getBoundingClientRect(), k = ratio();
    return { x: (e.clientX - box.left) * k, y: (e.clientY - box.top) * k };
  };
  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!ready || busy || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    current.current = { tool, color, size: size * ratio(), points: [point(e)] };
    redraw(current.current);
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = current.current;
    if (!s || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const p = point(e);
    if (s.tool === "pen") s.points.push(p);
    else s.points = [s.points[0]!, p];
    redraw(s);
  };
  const up = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = current.current;
    current.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!s) return;
    const a = s.points[0]!, b = s.points[s.points.length - 1]!;
    // 화살표·동그라미는 끌어야 그려진다(점만 찍은 것은 버린다).
    if (s.tool !== "pen" && Math.hypot(b.x - a.x, b.y - a.y) < 4 * ratio()) return redraw();
    setStrokes((cur) => [...cur, s]);
    setUndone([]);
  };
  const undo = () => {
    const last = strokes[strokes.length - 1];
    if (!last) return;
    setStrokes(strokes.slice(0, -1));
    setUndone([...undone, last]);
  };
  const redo = () => {
    const last = undone[undone.length - 1];
    if (!last) return;
    setUndone(undone.slice(0, -1));
    setStrokes([...strokes, last]);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z" || e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  };
  const save = async () => {
    const c = canvas.current;
    if (!c || busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, quality));
      let blob = await encode("image/png");
      let ext = "png";
      // PNG 가 너무 크면 JPEG 로 다시 만든다(사진처럼 색이 많은 그림).
      if (blob && blob.size > MAX_BYTES) {
        blob = await encode("image/jpeg", 0.9);
        ext = "jpg";
      }
      if (!blob) throw new Error("그림을 만들지 못했습니다");
      if (blob.size > MAX_BYTES) throw new Error("그린 그림이 너무 큽니다(4MB 까지)");
      const ok = await onSave(new File([blob], `${name.trim().slice(0, 150) || "그림"}.${ext}`, { type: blob.type }));
      if (ok) onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "그림을 저장하지 못했습니다");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={source !== null} onClose={onClose} title="그림 위에 그리기">
      <div className="aar-draw" onKeyDown={onKey}>
        <p className="aar-note">그림 위에 표시를 남깁니다. 저장하면 표시가 든 새 그림이 붙고, 원래 그림 파일은 바뀌지 않습니다.</p>
        <div className="aar-draw__tools" role="toolbar" aria-label="그리기 도구">
          <span className="aar-seg" role="group" aria-label="도구">
            {TOOLS.map((t) => <button key={t.key} type="button" className="aar-seg__btn" aria-pressed={tool === t.key} onClick={() => setTool(t.key)}>{t.label}</button>)}
          </span>
          <span className="aar-draw__colors" role="group" aria-label="색">
            {COLORS.map((c) => <button key={c.value} type="button" className="aar-draw__color" aria-label={c.label} aria-pressed={color === c.value} style={{ background: c.value }} onClick={() => setColor(c.value)} />)}
          </span>
          <span className="aar-seg" role="group" aria-label="굵기">
            {SIZES.map((s) => <button key={s.value} type="button" className="aar-seg__btn" aria-pressed={size === s.value} onClick={() => setSize(s.value)}>{s.label}</button>)}
          </span>
          <button type="button" className="vw-btn" disabled={busy || strokes.length === 0} onClick={undo}>되돌리기</button>
          <button type="button" className="vw-btn" disabled={busy || undone.length === 0} onClick={redo}>다시 하기</button>
          <button type="button" className="vw-btn" disabled={busy || strokes.length === 0} onClick={() => { setUndone([]); setStrokes([]); }}>모두 지우기</button>
        </div>
        <div className="aar-draw__stage">
          {failed ? <p className="aar-error" role="alert">그림을 열지 못했습니다.</p> : !ready ? <p className="aar-note" role="status">그림을 여는 중…</p> : null}
          <canvas ref={canvas} className="aar-draw__canvas" hidden={!ready} aria-label="그릴 그림" data-strokes={strokes.length}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { current.current = null; redraw(); }} />
        </div>
        <label className="aar-field">그림 이름<input value={name} maxLength={150} onChange={(e) => setName(e.target.value)} /></label>
        {error ? <p className="aar-error" role="alert">{error}</p> : null}
        <div className="aar-actions">
          <GlassButton variant="primary" size="s" disabled={busy || !ready || strokes.length === 0} onClick={() => void save()}>{busy ? "붙이는 중" : "표시한 그림으로 바꾸기"}</GlassButton>
          <GlassButton variant="ghost" size="s" disabled={busy} onClick={onClose}>그리기 그만</GlassButton>
        </div>
      </div>
    </Modal>
  );
}
