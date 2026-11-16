// 도식(Mermaid) 그리기. 도식 글은 직원·AI 가 쓴 믿을 수 없는 글이라, 그리는 부품(약 5MB)을 이 화면 문서에서 돌리지 않는다.
// 보이지 않는 격리된 칸(iframe, 출처 없음)에 서버의 '/vendor/diagram-frame' 을 열고, 도식 글을 메시지로 보내 그림(SVG 글)만 돌려받는다.
// 칸은 문서에 도식이 있을 때 처음 만든다. 돌려받은 SVG 는 화면에 직접 끼우지 않고 <img> 로만 보인다:
// 그림으로 열린 SVG 는 스크립트가 돌지 않고, 바깥 주소를 부르지 못하고, 페이지의 다른 곳을 덮거나 꾸밀 수 없다.

const FRAME_SRC = "/vendor/diagram-frame";
const READY_MS = 45_000;
const RENDER_MS = 30_000;

/** 그리는 부품의 설정. 칸 안에서 그대로 쓴다. */
const CONFIG = {
  startOnLoad: false,
  // 엄격: 도식 글의 HTML·누르기 동작을 쓰지 않는다.
  securityLevel: "strict",
  theme: "base",
  // <img> 안에서는 페이지의 글꼴 설정이 닿지 않는다. 기기 글꼴을 적어 준다.
  fontFamily: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif',
  themeVariables: { primaryColor: "#f1edff", primaryBorderColor: "#7a5bff", primaryTextColor: "#17132b", lineColor: "#6b6780", secondaryColor: "#f5f4f8", tertiaryColor: "#ffffff", fontSize: "15px" },
  // 이름표를 HTML 로 그리지 않는다(그림으로 열면 HTML 이름표가 보이지 않는 브라우저가 있다).
  htmlLabels: false,
  flowchart: { htmlLabels: false },
};

export interface DiagramImage {
  /** SVG 글 전체. <img> 의 주소(blob)로 만들어 쓴다. */
  svg: string;
  width: number;
  height: number;
}

interface Frame {
  window: Window;
  waiting: Map<string, { resolve: (image: DiagramImage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
}

let frame: Promise<Frame> | null = null;
let seq = 0;

function toImage(svg: unknown): DiagramImage {
  if (typeof svg !== "string" || !/^\s*<svg[\s>]/i.test(svg) || svg.length > 4_000_000) throw new Error("그림을 만들지 못했습니다");
  const box = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(svg);
  const width = box ? Math.ceil(Number(box[1])) : 0, height = box ? Math.ceil(Number(box[2])) : 0;
  if (!width || !height) throw new Error("그림을 만들지 못했습니다");
  return { svg, width, height };
}

/** 격리된 칸을 한 번만 만든다. 열지 못하면 다음 부름에서 다시 만든다. */
function openFrame(): Promise<Frame> {
  frame ??= new Promise<Frame>((resolve, reject) => {
    const el = document.createElement("iframe");
    // 출처 없는 칸: 스크립트만 돌고, 이 화면의 DOM·저장소·쿠키에 닿지 못한다.
    el.setAttribute("sandbox", "allow-scripts");
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.title = "도식 그리기";
    // 부품이 글자 크기를 재려면 칸이 실제 크기로 그려져 있어야 한다. 화면 밖에 두고 보이지 않게 한다.
    el.style.cssText = "position:fixed;left:-20000px;top:0;width:1600px;height:1200px;border:0;opacity:0;pointer-events:none";
    const state: Frame = { window: window, waiting: new Map() };
    const drop = (error: Error) => {
      window.removeEventListener("message", onMessage);
      el.remove();
      frame = null;
      for (const w of state.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(error);
      }
      state.waiting.clear();
      reject(error);
    };
    const timer = setTimeout(() => drop(new Error("도식 부품을 받지 못했습니다")), READY_MS);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== el.contentWindow) return;
      const m = event.data as { kind?: unknown; ok?: unknown; id?: unknown; svg?: unknown; error?: unknown } | null;
      if (!m || typeof m !== "object") return;
      if (m.kind === "aar-diagram-ready") {
        clearTimeout(timer);
        if (m.ok !== true || !el.contentWindow) return drop(new Error("도식 부품을 읽지 못했습니다"));
        state.window = el.contentWindow;
        resolve(state);
      } else if (m.kind === "aar-diagram-result" && typeof m.id === "string") {
        const w = state.waiting.get(m.id);
        if (!w) return;
        state.waiting.delete(m.id);
        clearTimeout(w.timer);
        if (typeof m.error === "string") return w.reject(new Error(m.error.slice(0, 200) || "도식을 그리지 못했습니다"));
        try {
          w.resolve(toImage(m.svg));
        } catch (e) {
          w.reject(e instanceof Error ? e : new Error("그림을 만들지 못했습니다"));
        }
      }
    };
    window.addEventListener("message", onMessage);
    el.addEventListener("error", () => drop(new Error("도식 부품을 받지 못했습니다")));
    el.src = FRAME_SRC;
    document.body.append(el);
  });
  return frame;
}

/** 도식 글을 그림(SVG)으로 그린다. 문법이 틀렸거나 그리지 못하면 그 까닭을 던진다. */
export async function renderDiagram(code: string): Promise<DiagramImage> {
  const target = await openFrame();
  return new Promise<DiagramImage>((resolve, reject) => {
    const id = `d${++seq}`;
    const timer = setTimeout(() => {
      target.waiting.delete(id);
      reject(new Error("도식을 그리는 데 너무 오래 걸립니다"));
    }, RENDER_MS);
    target.waiting.set(id, { resolve, reject, timer });
    // 칸은 출처가 없어 받는 쪽 출처를 적을 수 없다('*'). 보내는 것은 도식 글과 고정된 설정뿐이다.
    target.window.postMessage({ kind: "aar-diagram", id, code, config: CONFIG }, "*");
  });
}
