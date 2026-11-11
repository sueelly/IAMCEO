// 아티팩트를 격리 칸에 그린다. 계약: docs/spec.md §3.2, 원본 조립: shared/artifact-kit.ts.
// 스크립트가 있는 자료: 칸(sandbox allow-scripts + 헤더 sandbox)은 불투명 출처라 접속 코드·저장소·이 서버 API 에 닿지 못한다. 첨부 주소를 이 안으로 넘기지 않는다.
// 스크립트 없는 자료(isScriptlessArtifact): '실행' 없이 sandbox="allow-same-origin" srcdoc 칸에 바로 그린다. 칸 안에서는 스크립트가 돌지 않고,
//   높이 재기·표 감싸기·링크와 # 이동은 부모(이 파일)가 칸 문서에 직접 한다. allow-scripts 와 allow-same-origin 을 한 칸에 함께 두지 않는다.
// 전체 화면은 칸을 옮기지 않는다. 옮기면 다시 읽혀 아티팩트의 탭 선택 등이 사라진다.
// <dialog> 를 평소엔 보통 상자로 두고 showModal 로 최상단 층에 올린다(유리 판의 backdrop-filter 도 빠져나간다, 폰도 된다).
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ARTIFACT_FRAME_PATH, ARTIFACT_SANDBOX, ARTIFACT_STATIC_SANDBOX, buildArtifactSrcdoc, isScriptlessArtifact } from "@shared/artifact-kit";
import { api, errorText } from "../lib/api";

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 20_000;
/** 칸이 뜨지 않으면 실패로 친다. */
const FRAME_TIMEOUT_MS = 12_000;
/**
 * 작성자 CSS 가 칸 높이를 따라 자라면(min-height:100vh + padding 등) 키울수록 또 커진다. 멈추고 칸 안 스크롤로 둔다.
 * 키운 만큼 똑같이 더 커지기를 거듭하거나, 3초에 너무 자주 커지면 그렇게 본다(글이 펼쳐지는 움직임은 폭이 일정하지 않고 금방 끝난다).
 */
const RUNAWAY_SAME_STEP = 8;
const RUNAWAY_GROWS = 40;
const RUNAWAY_WINDOW_MS = 3000;
const XLINK = "http://www.w3.org/1999/xlink";

/** 칸이 보낸 값은 믿지 않는다. 수이고 범위 안일 때만. */
export function readReportedHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value)));
}

/** 칸 안에서 누른 링크. 바깥 http(s) 만 받는다. */
export function readReportedLink(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== origin ? url.href : null;
  } catch {
    return null;
  }
}

/** 칸 안 # 대상의 위치(칸 맨 위에서 px). 수이고 범위 안일 때만, 칸 높이 안으로 줄인다. */
export function readReportedAnchor(value: unknown, frameHeight: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) return null;
  return Math.min(Math.round(value), Math.max(0, Math.floor(frameHeight) - 1));
}

type Load = { status: "loading" } | { status: "error"; text: string } | { status: "ready"; doc: string };

/** 이 창에서 대표가 이미 실행한 아티팩트. 탭을 오갈 때 다시 묻지 않는다. 새로고침하면 비어 다시 묻는다. */
const started = new Set<string>();

type Pick = { mode: "check" } | { mode: "gate" } | { mode: "run" } | { mode: "static"; html: string };

/**
 * 스크립트가 있는 자료는 누르기 전에는 칸을 만들지 않는다. WebKit 은 칸과 부모가 같은 메인 스레드를 써서, AI 가 쓴 무한 루프 하나로 결재·입력칸까지 멈춘다.
 * 자료 탭의 자동 선택과 주소 복원으로 열려도 마찬가지다. 원본은 받아서 글자로만 본다(받기만 해서는 아무것도 돌지 않는다).
 * 스크립트가 없으면 돌 것이 없으므로 바로 그린다. 부르는 쪽은 자료마다 key 를 준다.
 */
export function ArtifactFrame({ fileId, title }: { fileId: string; title: string }) {
  const [pick, setPick] = useState<Pick>(() => (started.has(fileId) ? { mode: "run" } : { mode: "check" }));

  useEffect(() => {
    if (pick.mode !== "check") return;
    const abort = { done: false };
    api.artifact(fileId).then(
      ({ html }) => {
        if (!abort.done) setPick(isScriptlessArtifact(html) ? { mode: "static", html } : { mode: "gate" });
      },
      // 받지 못하면 예전처럼 '실행' 칸을 둔다. 누르면 다시 받고, 실패를 보여 준다.
      () => {
        if (!abort.done) setPick({ mode: "gate" });
      },
    );
    return () => {
      abort.done = true;
    };
  }, [fileId, pick.mode]);

  if (pick.mode === "run") return <ArtifactStage fileId={fileId} title={title} />;
  if (pick.mode === "static") return <StaticStage html={pick.html} title={title} />;
  if (pick.mode === "check") return <p className="vw-note">불러오는 중입니다</p>;
  return (
    <div className="vw-fail">
      <p className="vw-note">직원이 만든 페이지입니다. 실행하면 안의 스크립트가 돕니다.</p>
      <button
        type="button"
        className="vw-btn"
        onClick={() => {
          started.add(fileId);
          setPick({ mode: "run" });
        }}
      >
        실행
      </button>
    </div>
  );
}

/** 칸 높이를 글에 맞춘다. 스스로 자라는 글이면 멈추고 칸 안 스크롤로 둔다. */
function useFittedHeight() {
  const [height, setHeight] = useState(480);
  const fit = useRef({ grows: [] as number[], step: 0, sameStep: 0, frozen: false, stable: 480 });
  const reset = useCallback(() => {
    fit.current = { grows: [], step: 0, sameStep: 0, frozen: false, stable: 480 };
  }, []);
  /** 받아들였으면 true. */
  const report = useCallback((value: unknown): boolean => {
    const next = readReportedHeight(value);
    const p = fit.current;
    if (next === null || p.frozen) return false;
    // 같은 값은 바뀐 것이 없다. 부모가 여러 길(관찰자·이벤트)로 재면 같은 값이 거듭 오는데, 이를 '안 자람'으로 세면 자라는 글을 놓친다.
    if (next === p.stable) return true;
    const now = Date.now();
    p.grows = p.grows.filter((t) => now - t < RUNAWAY_WINDOW_MS);
    const step = next - p.stable;
    p.sameStep = step > 0 && step === p.step ? p.sameStep + 1 : 0;
    p.step = step;
    if (step > 0) p.grows.push(now);
    if (p.sameStep >= RUNAWAY_SAME_STEP || p.grows.length > RUNAWAY_GROWS) {
      p.frozen = true;
      setHeight(Math.max(MIN_HEIGHT, window.innerHeight));
      return true;
    }
    p.stable = next;
    setHeight(next);
    return true;
  }, []);
  return { height, report, reset, fit };
}

/**
 * 맞춤 칸의 # 이동. 칸이 글 높이라 칸 안에는 굴릴 곳이 없다. 칸 위에 겹친 표지를 그 높이에 두고 표지를 화면으로 끌어온다
 * (자료 화면이 창을 굴리든 안쪽 상자를 굴리든 scrollIntoView 가 맞는 상자를 굴린다).
 */
function useAnchorMark(): [RefObject<HTMLSpanElement | null>, (y: number) => void] {
  const ref = useRef<HTMLSpanElement>(null);
  const go = useCallback((y: number) => {
    const mark = ref.current;
    if (!mark) return;
    mark.style.top = `${y}px`;
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    mark.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  }, []);
  return [ref, go];
}

const MARK_STYLE = { position: "absolute", left: 0, top: 0, width: 1, height: 1, pointerEvents: "none", scrollMarginTop: 12 } as const;

/** 두 칸이 함께 쓰는 겉: 막대(전체 화면)·칸 자리·링크 확인. */
function Shell(props: {
  hostRef: RefObject<HTMLDialogElement | null>;
  markRef: RefObject<HTMLSpanElement | null>;
  title: string;
  full: boolean;
  setFull: (v: boolean) => void;
  height: number;
  failed: ReactNode | null;
  painted: boolean;
  link: string | null;
  clearLink: () => void;
  children: ReactNode;
}) {
  const { hostRef, markRef, title, full, setFull, height, failed, painted, link, clearLink, children } = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClose = () => setFull(false);
    host.addEventListener("close", onClose);
    return () => host.removeEventListener("close", onClose);
  }, [hostRef, setFull]);

  const toggleFull = () => {
    const host = hostRef.current;
    if (!host) return;
    if (host.open) host.close();
    else {
      host.showModal();
      setFull(true);
    }
  };

  return (
    <dialog ref={hostRef} className="afr" role={full ? undefined : "group"} aria-label={full ? title : undefined}>
      {failed ? null : (
        <div className="afr-bar">
          <span className="afr-bar__title">{full ? title : ""}</span>
          <button type="button" className="vw-btn" onClick={toggleFull}>
            {full ? "닫기" : "전체 화면"}
          </button>
        </div>
      )}
      <div className="afr-stage" style={full ? undefined : { height: failed ? undefined : height }}>
        {failed ?? children}
        {!failed && !painted ? <p className="afr-loading">불러오는 중입니다</p> : null}
        <span ref={markRef} aria-hidden="true" style={MARK_STYLE} />
      </div>
      {link ? (
        <div className="afr-link">
          <span className="afr-link__url t-code">{link}</span>
          <span className="vw-bar__actions">
            <a className="vw-btn" href={link} target="_blank" rel="noopener noreferrer">
              열기
            </a>
            <button type="button" className="vw-btn" onClick={clearLink}>
              닫기
            </button>
          </span>
        </div>
      ) : null}
    </dialog>
  );
}

function ArtifactStage({ fileId, title }: { fileId: string; title: string }) {
  const hostRef = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [markRef, scrollToMark] = useAnchorMark();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [painted, setPainted] = useState(false);
  const { height, report, reset, fit } = useFittedHeight();
  const heightRef = useRef(height);
  heightRef.current = height;
  const [full, setFull] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  // 칸이 준비됐다는 알림과 원본 도착은 순서가 정해져 있지 않다. 문서는 칸마다 한 번만 넣는다(그 뒤의 준비 알림은 작성자 글이 보낸 것이다).
  const pipe = useRef({ doc: null as string | null, ready: false, sent: false });

  const deliver = useCallback(() => {
    const p = pipe.current;
    const win = frameRef.current?.contentWindow;
    if (!win || !p.ready || p.sent || p.doc === null) return;
    p.sent = true;
    win.postMessage({ iamceoSrcdoc: p.doc }, "*"); // 불투명 출처라 대상을 '*' 로만 쓸 수 있다. 받는 쪽은 parent 인지 확인한다.
  }, []);

  useEffect(() => {
    const abort = { done: false };
    pipe.current = { doc: null, ready: false, sent: false };
    reset();
    setLoad({ status: "loading" });
    setPainted(false);
    setLink(null);
    api.artifact(fileId).then(
      ({ html }) => {
        if (abort.done) return;
        const doc = buildArtifactSrcdoc(html, { title });
        pipe.current.doc = doc;
        setLoad({ status: "ready", doc });
        deliver();
      },
      (e: unknown) => {
        if (!abort.done) setLoad({ status: "error", text: errorText(e) });
      },
    );
    return () => {
      abort.done = true;
    };
  }, [fileId, title, attempt, deliver, reset]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      // 칸이 보낸 것만. 칸은 opaque 출처라 origin 으로는 가를 수 없다.
      if (!frame || e.source !== frame.contentWindow || typeof e.data !== "object" || e.data === null) return;
      const data = e.data as Record<string, unknown>;
      const p = pipe.current;
      if (data.iamceoFrameReady === true) {
        if (!p.sent) {
          p.ready = true;
          deliver();
        }
        return;
      }
      if (!p.sent) return;
      if ("iamceoHeight" in data) {
        if (readReportedHeight(data.iamceoHeight) !== null && !fit.current.frozen) setPainted(true);
        report(data.iamceoHeight);
      } else if ("iamceoAnchor" in data) {
        // 전체 화면과 멈춘 칸은 칸 안에서 스스로 움직인다.
        if (hostRef.current?.open || fit.current.frozen) return;
        const y = readReportedAnchor(data.iamceoAnchor, heightRef.current);
        if (y !== null) scrollToMark(y);
      } else if ("iamceoLink" in data) {
        const url = readReportedLink(data.iamceoLink, location.origin);
        if (url) setLink(url);
      } else if (data.iamceoEscape === true) {
        // 초점이 칸 안에 있으면 Esc 가 이쪽으로 오지 않는다
        if (hostRef.current?.open) hostRef.current.close();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [deliver, report, fit, scrollToMark]);

  useEffect(() => {
    if (load.status !== "ready" || painted) return;
    const t = setTimeout(() => {
      setLoad({ status: "error", text: "칸을 열지 못했습니다" });
    }, FRAME_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [load.status, painted, attempt]);

  const failed =
    load.status === "error" ? (
      <div className="vw-fail" role="alert">
        <p className="vw-note" data-tone="bad">
          아티팩트를 불러오지 못했습니다. {load.text}
        </p>
        <button type="button" className="vw-btn" onClick={() => setAttempt((n) => n + 1)}>
          다시 시도
        </button>
      </div>
    ) : null;

  return (
    <Shell hostRef={hostRef} markRef={markRef} title={title} full={full} setFull={setFull} height={height} failed={failed} painted={painted} link={link} clearLink={() => setLink(null)}>
      <iframe
        key={attempt}
        ref={frameRef}
        className="afr-frame"
        sandbox={ARTIFACT_SANDBOX}
        src={ARTIFACT_FRAME_PATH}
        title={title}
        referrerPolicy="no-referrer"
      />
    </Shell>
  );
}

// 칸 문서의 것은 부모 쪽 원형으로 부른다. document 는 이름 붙은 요소가 제 속성을 가린다(<img name="getElementById"> 등).
// 모듈을 읽을 때가 아니라 쓸 때 꺼낸다(DOM 없는 곳에서 이 파일을 읽어도 깨지지 않게).
function dom() {
  const D = Document.prototype;
  const get = (name: string) => Object.getOwnPropertyDescriptor(D, name)?.get;
  return {
    D,
    E: Element.prototype,
    T: EventTarget.prototype,
    body: (d: Document) => (get("body")!.call(d) as HTMLElement | null),
    root: (d: Document) => (get("documentElement")!.call(d) as HTMLElement | null),
    fonts: (d: Document) => (get("fonts")?.call(d) as FontFaceSet | undefined),
  };
}

/** 칸 안 링크·영역의 주소. SVG 링크는 xlink:href 도 본다. */
function hrefOf(el: Element): string | null {
  const { E } = dom();
  return E.getAttribute.call(el, "href") ?? E.getAttributeNS.call(el, XLINK, "href");
}

/** 칸 문서에서 # 대상의 위치(문서 맨 위에서 px). 대상이 없으면 null('#'·'#top' 은 맨 위). */
export function anchorOffset(doc: Document, win: Window, hash: string): number | null {
  const { D, E } = dom();
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // 풀 수 없으면 글자 그대로 찾는다
  }
  const target = id ? (D.getElementById.call(doc, id) ?? D.getElementsByName.call(doc, id)[0] ?? null) : null;
  if (target) return E.getBoundingClientRect.call(target).top + win.scrollY;
  return !id || id.toLowerCase() === "top" ? 0 : null;
}

/** 스크립트 없는 자료. 칸 안에서는 아무것도 돌지 않으니 '실행' 을 묻지 않는다. 원본은 부르는 쪽이 이미 받았다. */
function StaticStage({ html, title }: { html: string; title: string }) {
  const hostRef = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [markRef, scrollToMark] = useAnchorMark();
  const [painted, setPainted] = useState(false);
  const { height, report, fit } = useFittedHeight();
  const heightRef = useRef(height);
  heightRef.current = height;
  const [full, setFull] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [doc] = useState(() => buildArtifactSrcdoc(html, { title, scripts: false }));
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const attach = useCallback(() => {
    cleanup.current?.();
    cleanup.current = null;
    const frame = frameRef.current;
    const d = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!frame || !d || !win) return;
    const { D, E, T, body: bodyOf, root: rootOf, fonts } = dom();
    const body = bodyOf(d);
    const root = rootOf(d);
    if (!root) return;

    // 표를 가로 스크롤 상자로 감싼다(스크립트 칸에서는 칸 안 스크립트가 하는 일).
    for (const t of D.querySelectorAll.call(d, "table")) {
      const parent = t.parentElement;
      if (!parent || parent.classList.contains("kit-table")) continue;
      const wrap = D.createElement.call(d, "div");
      wrap.className = "kit-table";
      parent.insertBefore(wrap, t);
      wrap.appendChild(t);
    }

    const measure = () => {
      const b = bodyOf(d);
      let n = 0;
      if (b) {
        const c = win.getComputedStyle(b);
        n = b.scrollHeight + (parseFloat(c.marginTop) || 0) + (parseFloat(c.marginBottom) || 0);
      } else n = root.scrollHeight;
      if (report(Math.ceil(n))) setPainted(true);
    };

    // 링크는 composedPath 로 찾는다. 그림자 DOM 안의 클릭은 e.target 이 바깥 주인으로 바뀌어 closest 로는 못 찾는다
    // (선언형 그림자 DOM 자료는 isScriptlessArtifact 가 '실행' 길로 보내지만, 칸이 넘어가지 않게 한 번 더 막는다).
    const linkOf = (e: MouseEvent): Element | null => {
      for (const n of e.composedPath()) {
        if ((n as Node).nodeType !== 1) continue;
        const el = n as Element;
        if (E.matches.call(el, "a, area")) return el;
      }
      const t = e.target as Node | null;
      const start = t && t.nodeType === 1 ? (t as Element) : (t?.parentElement ?? null);
      return start ? E.closest.call(start, "a, area") : null;
    };

    const onClick = (e: MouseEvent) => {
      const a = linkOf(e);
      if (!a) return;
      // 칸이 넘어가지 않게 늘 막는다. srcdoc 의 '#x' 는 부모 주소로 풀려 칸에 앱 화면이 뜬다.
      e.preventDefault();
      const href = hrefOf(a);
      if (href === null) return;
      if (href.startsWith("#")) {
        const y = anchorOffset(d, win, href);
        if (y === null) return;
        if (hostRef.current?.open || fit.current.frozen) win.scrollTo({ top: y });
        else {
          const at = readReportedAnchor(y, heightRef.current);
          if (at !== null) scrollToMark(at);
        }
        return;
      }
      let url: string | null = null;
      try {
        url = readReportedLink(new URL(href, location.href).href, location.origin);
      } catch {
        url = null;
      }
      if (url) setLink(url);
    };
    const onKey = (e: KeyboardEvent) => {
      // 초점이 칸 안에 있으면 Esc 가 이쪽으로 오지 않는다
      if (e.key === "Escape" && hostRef.current?.open) hostRef.current.close();
    };
    T.addEventListener.call(d, "click", onClick as EventListener, true);
    T.addEventListener.call(d, "keydown", onKey as EventListener, true);
    // 접기 펼치기·늦게 뜬 그림·글꼴·폭 바뀜. 관찰자가 칸 문서를 못 보는 브라우저도 있어 이벤트도 함께 듣는다.
    T.addEventListener.call(d, "toggle", measure, true);
    T.addEventListener.call(d, "load", measure, true);
    win.addEventListener("resize", measure);
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(measure);
      ro.observe(root);
      if (body) ro.observe(body);
    } catch {
      ro = null;
    }
    fonts(d)?.ready.then(measure, () => {});
    measure();
    cleanup.current = () => {
      ro?.disconnect();
      win.removeEventListener("resize", measure);
    };
  }, [report, fit, scrollToMark]);

  return (
    <Shell hostRef={hostRef} markRef={markRef} title={title} full={full} setFull={setFull} height={height} failed={null} painted={painted} link={link} clearLink={() => setLink(null)}>
      <iframe ref={frameRef} className="afr-frame" sandbox={ARTIFACT_STATIC_SANDBOX} srcDoc={doc} title={title} referrerPolicy="no-referrer" onLoad={attach} data-static="" />
    </Shell>
  );
}
