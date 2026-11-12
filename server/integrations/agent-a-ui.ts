// Agent-A 원래 화면을 IAMCEO 주소 아래(/agent-a-ui/s/<입장권>/...)로 이어 준다.
// - 대표가 IAMCEO 를 여는 곳(이 Mac·Tailscale·폰·앱)이면 어디서든 같은 화면이 뜬다. Agent-A 는 계속 127.0.0.1 에만 열려 있다.
// - Agent-A 열쇠(앱 토큰)는 이 서버만 붙인다. 브라우저에는 주소도 열쇠도 넘기지 않는다.
// - 화면은 격리 칸(sandbox, allow-same-origin 없음)에서 돈다: Agent-A 문서·답에 무엇이 들어 있어도 IAMCEO 접속 코드·쿠키에 닿지 못한다.
//   그래서 쿠키 대신 짧게 사는 입장권을 경로에 넣고, 응답에 CORS(*)를 붙인다(격리 칸의 출처는 'null').
// - IAMCEO 모양: 응답 HTML 에 shim.js(주소 앞붙이기·저장소 대체·불필요한 머리줄 숨김)와 skin.css(IAMCEO 색·글꼴·모서리)를 넣는다.
import { randomBytes } from "node:crypto";
import type { AgentAClient } from "./agent-a.ts";

export const AGENT_A_UI_ROOT = "/agent-a-ui/s/";
const TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const TICKET = /^[A-Za-z0-9_-]{43}$/;

/** 원래 화면 입장권. 서버 메모리에만 있고, 서버를 다시 켜거나 접속 코드를 바꾸면 모두 사라진다. */
export class AgentAUiTickets {
  private readonly tickets = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  mint(): { ticket: string; base: string; expiresAt: number } {
    const at = this.now();
    for (const [t, exp] of this.tickets) if (exp <= at) this.tickets.delete(t);
    while (this.tickets.size >= MAX_SESSIONS) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = at + TTL_MS;
    this.tickets.set(ticket, expiresAt);
    return { ticket, base: `${AGENT_A_UI_ROOT}${ticket}`, expiresAt };
  }

  valid(ticket: string): boolean {
    if (!TICKET.test(ticket)) return false;
    const exp = this.tickets.get(ticket);
    if (exp === undefined) return false;
    if (exp <= this.now()) {
      this.tickets.delete(ticket);
      return false;
    }
    return true;
  }

  clear(): void {
    this.tickets.clear();
  }
}

/** /agent-a-ui/s/<입장권>/<나머지> 를 나눈다. 모양이 다르면 null. */
export function splitAgentAUiPath(pathname: string): { ticket: string; prefix: string; rest: string } | null {
  if (!pathname.startsWith(AGENT_A_UI_ROOT)) return null;
  const tail = pathname.slice(AGENT_A_UI_ROOT.length);
  const slash = tail.indexOf("/");
  const ticket = slash === -1 ? tail : tail.slice(0, slash);
  const rest = slash === -1 ? "/" : tail.slice(slash);
  if (!TICKET.test(ticket)) return null;
  return { ticket, prefix: `${AGENT_A_UI_ROOT}${ticket}`, rest };
}

// 격리 칸 안 화면이 보내는 요청 머리 중 Agent-A 로 넘길 것만. 쿠키·IAMCEO 인증·출처 머리는 넘기지 않는다.
const FORWARD = ["accept", "accept-language", "content-type", "range", "last-event-id", "x-enouv-artifact", "x-enouv-review-session"];
// Agent-A 응답에서 버릴 것. 캐시 머리는 고친 글(HTML·JS·CSS)에서만 따로 버린다.
const DROP = ["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "content-security-policy", "x-frame-options", "access-control-allow-origin", "access-control-allow-credentials"];

function corsHeaders(h: Headers): void {
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE");
  h.set("Access-Control-Allow-Headers", "content-type, accept, x-enouv-artifact, x-enouv-review-session, last-event-id, range");
  h.set("Access-Control-Max-Age", "600");
  h.set("Vary", "Origin");
}

/** 격리 칸에서만 돌게 한다. 다른 사이트가 이 화면을 품지 못하고, 밖으로 나가는 요청도 없다. */
function frameHeaders(h: Headers): void {
  h.set(
    "Content-Security-Policy",
    [
      "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "media-src 'self' data: blob:",
      "worker-src 'self' blob:",
      "frame-src 'self' blob: data:",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  );
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
}

const ROOTED = /(\s(?:src|href)=["'])\/(?!\/)/g;

/** HTML: 맨 앞에 IAMCEO 모양·주소 맞춤을 넣고, 뿌리 경로(/assets/...)를 입장권 경로로 바꾼다. */
export function rewriteHtml(html: string, prefix: string): string {
  const head = `<head><link rel="stylesheet" href="${prefix}/__iamceo/skin.css"><script src="${prefix}/__iamceo/shim.js"></script>`;
  return html.replace(ROOTED, (_m, a: string) => `${a}${prefix}/`).replace(/<head>/i, head);
}

/** Vite 미리 읽기 도우미의 `"/"+파일` 과 CSS 의 url(/...) 를 입장권 경로로 바꾼다. */
export function rewriteAsset(text: string, kind: "js" | "css", prefix: string): string {
  if (kind === "css") return text.replace(/url\((["']?)\/(?!\/)/g, (_m, q: string) => `url(${q}${prefix}/`);
  return text.replace(/return`\/`\+(\w+)/g, (_m, v: string) => `return\`${prefix}/\`+${v}`).replace(/return"\/"\+(\w+)/g, (_m, v: string) => `return"${prefix}/"+${v}`);
}

/** 원래 화면 요청 하나를 Agent-A 로 넘긴다. 입장권 검사는 부르는 쪽(http.ts)이 먼저 한다. */
export async function proxyAgentAUi(req: Request, url: URL, prefix: string, rest: string, client: AgentAClient): Promise<Response> {
  if (req.method === "OPTIONS") {
    const h = new Headers();
    corsHeaders(h);
    return new Response(null, { status: 204, headers: h });
  }
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return new Response("허용되지 않는 메서드입니다", { status: 405 });
  if (rest === "/__iamceo/shim.js" || rest === "/__iamceo/skin.css") {
    const js = rest.endsWith(".js");
    const h = new Headers({ "Content-Type": js ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "Cache-Control": "no-cache" });
    corsHeaders(h);
    frameHeaders(h);
    return new Response(js ? SHIM_JS : SKIN_CSS, { headers: h });
  }
  const headers: Record<string, string> = {};
  for (const name of FORWARD) {
    const v = req.headers.get(name);
    if (v !== null) headers[name] = v;
  }
  // 해시가 붙은 정적 파일만 조건부 요청을 넘긴다. HTML 은 고쳐서 내보내므로 늘 새로 받는다.
  if (rest.startsWith("/assets/") && !rest.startsWith("/assets/user/")) {
    const inm = req.headers.get("if-none-match");
    if (inm) headers["if-none-match"] = inm;
  }
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const res = await client.forward(rest + url.search, { method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined });
  const h = new Headers(res.headers);
  for (const name of DROP) h.delete(name);
  corsHeaders(h);
  frameHeaders(h);
  const type = (h.get("content-type") ?? "").toLowerCase();
  const kind = type.includes("text/html") ? "html" : type.includes("javascript") ? "js" : type.includes("text/css") ? "css" : null;
  if (!kind || req.method === "HEAD" || res.status === 304) return new Response(req.method === "HEAD" ? null : res.body, { status: res.status, headers: h });
  const text = await res.text();
  const out = kind === "html" ? rewriteHtml(text, prefix) : rewriteAsset(text, kind, prefix);
  if (kind === "html") {
    h.delete("etag");
    h.delete("last-modified");
    h.set("Cache-Control", "no-cache");
  }
  return new Response(out, { status: res.status, headers: h });
}

// ---- 격리 칸 안에서 도는 맞춤 ----
// 1) 뿌리 경로(/api/..., /assets/...)를 입장권 경로로 바꾼다: fetch·XHR·EventSource·history·window.open·src/href 속성.
// 2) 격리 칸에는 localStorage·sessionStorage·쿠키가 없다. 화면이 멈추지 않게 이 칸 안에서만 쓰는 메모리 저장소를 준다.
// 3) IAMCEO 자료 칸에서 뜻이 없는 것을 숨긴다: 문서 주소 줄(enouv:...), 닫기, 문서 목록으로 가기, 사용법 링크, 정본 표시 글.
export const SHIM_JS = String.raw`(() => {
  "use strict";
  const m = /^\/agent-a-ui\/s\/[A-Za-z0-9_-]{43}/.exec(location.pathname);
  if (!m) return;
  const P = m[0];
  const fix = (u) => {
    if (u == null) return u;
    const s = typeof u === "string" ? u : u instanceof URL ? u.href : null;
    if (s === null) return u;
    if (s.startsWith("/") && !s.startsWith("//")) return s.startsWith(P + "/") || s === P ? s : P + s;
    try {
      const x = new URL(s, location.href);
      if (x.host === location.host && /^https?:$/.test(x.protocol) && !x.pathname.startsWith(P + "/") && x.pathname !== P) return x.protocol + "//" + x.host + P + x.pathname + x.search + x.hash;
    } catch {}
    return s;
  };
  const memory = () => {
    const d = new Map();
    return {
      get length() { return d.size; },
      key: (i) => [...d.keys()][i] ?? null,
      getItem: (k) => (d.has(String(k)) ? d.get(String(k)) : null),
      setItem: (k, v) => { d.set(String(k), String(v)); },
      removeItem: (k) => { d.delete(String(k)); },
      clear: () => d.clear(),
    };
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    let ok = false;
    try { ok = !!window[name]; } catch {}
    if (!ok) { const s = memory(); try { Object.defineProperty(window, name, { configurable: true, get: () => s }); } catch {} }
  }
  try { void document.cookie; } catch {
    const jar = new Map();
    try {
      Object.defineProperty(document, "cookie", { configurable: true,
        get: () => [...jar].map(([k, v]) => k + "=" + v).join("; "),
        set: (v) => { const [pair] = String(v).split(";"); const i = pair.indexOf("="); if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); } });
    } catch {}
  }
  const of = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (input instanceof Request) { const f = fix(input.url); return of(f === input.url ? input : new Request(f, input), init); }
    return of(fix(input), init);
  };
  const xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, u, ...rest) { return xo.call(this, method, fix(u), ...rest); };
  if (window.EventSource) {
    const ES = window.EventSource;
    window.EventSource = class extends ES { constructor(u, o) { super(fix(u), o); } };
  }
  for (const k of ["pushState", "replaceState"]) {
    const orig = history[k].bind(history);
    history[k] = (state, title, u) => (u === undefined || u === null ? orig(state, title) : orig(state, title, fix(u)));
  }
  const wo = window.open;
  window.open = function (u, ...rest) { return wo.call(window, u === undefined ? u : fix(u), ...rest); };
  const attrs = { A: "href", AREA: "href", LINK: "href", IMG: "src", SCRIPT: "src", SOURCE: "src", IFRAME: "src", VIDEO: "src", AUDIO: "src", TRACK: "src", EMBED: "src", INPUT: "src" };
  const sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    const n = String(name).toLowerCase();
    if ((n === "src" || n === "href") && typeof value === "string") value = fix(value);
    return sa.call(this, name, value);
  };
  for (const [ctor, prop] of [[HTMLAnchorElement, "href"], [HTMLLinkElement, "href"], [HTMLImageElement, "src"], [HTMLScriptElement, "src"], [HTMLSourceElement, "src"], [HTMLIFrameElement, "src"], [HTMLMediaElement, "src"]]) {
    const d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
    if (!d || !d.set) continue;
    Object.defineProperty(ctor.prototype, prop, { configurable: true, enumerable: d.enumerable, get: d.get, set(v) { d.set.call(this, typeof v === "string" ? fix(v) : v); } });
  }
  const sweep = (root) => {
    const list = root.querySelectorAll ? root.querySelectorAll("[src^='/'],[href^='/']") : [];
    for (const el of [root, ...list]) {
      const a = el.tagName && attrs[el.tagName];
      if (!a) continue;
      const v = el.getAttribute(a);
      if (v && v.startsWith("/") && !v.startsWith("//") && !v.startsWith(P + "/")) sa.call(el, a, fix(v));
    }
  };
  // IAMCEO 자료 칸에서 뜻이 없는 것만 숨긴다(Agent-A 판이 바뀌어 못 찾으면 그대로 둔다).
  //  - 머리줄의 문서 주소(enouv:...)·Agent-A 로고 링크(문서 목록으로 감)·닫기(검토를 끝내고 나감)
  //  - 사용법 링크, 'ENOUV canonical document' 표시, 왼쪽 아래 '← 문서'(문서 목록으로 감)
  //  '문서 관리'(수정안·이전 판), 'Save', 댓글·그림·전체 댓글은 그대로 둔다.
  const hide = (el) => { if (!el || el.dataset.iamceoHidden) return; el.dataset.iamceoHidden = "1"; el.style.setProperty("display", "none", "important"); };
  const tidy = () => {
    const header = document.querySelector("header[data-app-header]");
    if (header) {
      const name = header.querySelector("[data-header-document-name]");
      if (name) {
        // 문서 이름 묶음: '/' 표시와 이름이 함께 든 칸
        let el = name.parentElement;
        while (el && el !== header && ![...el.children].some((c) => c.getAttribute("aria-hidden") === "true" && (c.textContent || "").trim() === "/")) el = el.parentElement;
        hide(el && el !== header ? el : name);
      }
      for (const a of header.querySelectorAll("a[href]")) {
        let path = "";
        try { path = new URL(a.getAttribute("href"), location.href).pathname; } catch {}
        if (path === P + "/" || path === P) hide(a.parentElement && a.parentElement.children.length === 1 ? a.parentElement : a);
      }
      for (const b of header.querySelectorAll("button")) if ((b.textContent || "").trim() === "Close") hide(b);
    }
    for (const el of document.querySelectorAll(".enouv-home-link, a[aria-label='문서 목록으로']")) hide(el);
    for (const el of document.querySelectorAll("a, button, span, div, p")) {
      if (el.children.length > 1) continue;
      const t = (el.textContent || "").trim();
      if (t === "how does this work?" || t === "ENOUV canonical document") hide(el);
    }
  };
  let queued = false;
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; tidy(); }); };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") sweep(r.target);
      else for (const n of r.addedNodes) if (n.nodeType === 1) sweep(n);
    }
    later();
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href"] });
  document.documentElement.classList.add("iamceo-skin");
})();
`;

// IAMCEO 모양: 밝은 판, 보라 강조, IAMCEO 글꼴, 둥근 모서리. Agent-A(Plannotator) 색 변수 위에 덮는다(어느 테마·모드를 골라도 같다).
export const SKIN_CSS = String.raw`html.iamceo-skin, html.iamceo-skin.light, html.iamceo-skin[class*="theme-"] {
  color-scheme: light;
  --background: oklch(0.985 0.006 290) !important;
  --foreground: oklch(0.22 0.02 285) !important;
  --card: oklch(1 0 0) !important;
  --card-foreground: oklch(0.22 0.02 285) !important;
  --popover: oklch(1 0 0) !important;
  --popover-foreground: oklch(0.22 0.02 285) !important;
  --primary: oklch(0.55 0.21 287) !important;
  --primary-foreground: oklch(1 0 0) !important;
  --secondary: oklch(0.95 0.02 290) !important;
  --secondary-foreground: oklch(0.3 0.06 287) !important;
  --muted: oklch(0.955 0.01 290) !important;
  --muted-foreground: oklch(0.46 0.02 285) !important;
  --accent: oklch(0.93 0.04 290) !important;
  --accent-foreground: oklch(0.32 0.12 287) !important;
  --destructive: oklch(0.55 0.2 25) !important;
  --destructive-foreground: oklch(1 0 0) !important;
  --border: oklch(0.9 0.012 290) !important;
  --input: oklch(0.93 0.012 290) !important;
  --ring: oklch(0.55 0.21 287) !important;
  --success: oklch(0.55 0.15 155) !important;
  --success-foreground: oklch(1 0 0) !important;
  --warning: oklch(0.68 0.16 65) !important;
  --warning-foreground: oklch(0.22 0.02 285) !important;
  --code-bg: oklch(0.96 0.01 290) !important;
  --focus-highlight: oklch(0.55 0.21 287) !important;
  --font-sans: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Segoe UI", system-ui, sans-serif !important;
  --radius: 0.875rem !important;
}
html.iamceo-skin body { background: var(--background); font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }
html.iamceo-skin button, html.iamceo-skin input, html.iamceo-skin textarea, html.iamceo-skin select { font-family: var(--font-sans); }
html.iamceo-skin ::selection { background: oklch(0.55 0.21 287 / 0.22); }
/* 왼쪽 아래 '문서 관리'와 '다른 조건으로 질문'이 같은 자리에 겹친다. 질문 단추를 옆으로 옮긴다('← 문서'는 숨겼다). */
html.iamceo-skin .enouv-conversation-branches { left: 112px !important; border-radius: 10px !important; }
html.iamceo-skin .enouv-extension-trigger { border-radius: 10px; }
`;
