// 도식(Mermaid)을 그리는 격리된 칸. 도식 글은 직원·AI 가 쓴 믿을 수 없는 글이라, 그리는 부품(약 5MB)을 화면 문서에서 돌리지 않는다.
// 화면은 보이지 않는 칸(iframe) 하나에 이 문서를 열고, 도식 글을 메시지로 보내 그림(SVG 글)만 돌려받는다.
// - 칸의 문서는 sandbox(allow-scripts 만)로 열려 출처가 없다: 화면의 DOM·저장소·쿠키·접속 코드에 닿지 못한다.
// - 칸의 보안 정책은 이 서버의 스크립트 두 개만 허락한다. 그림·글꼴·연결·다른 칸은 모두 막는다(도식 글이 어떤 주소도 부르지 못한다).
// - 돌려받은 SVG 는 화면이 <img> 로만 보인다(web/src/lib/mermaid.ts).
// 공개된 라이브러리 파일과 고정된 작은 스크립트뿐이라 화면 묶음처럼 접속 코드 없이 내준다.

const FRAME_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>도식 그리기</title>
</head>
<body>
<script src="/vendor/mermaid.min.js"></script>
<script src="/vendor/diagram-frame.js"></script>
</body>
</html>
`;

/** 칸 안에서 도는 스크립트. 메시지로 받은 도식 글을 하나씩 그려 SVG 글이나 실패 까닭을 돌려준다. */
const RUNNER_JS = `(() => {
  "use strict";
  const api = globalThis.mermaid;
  let seq = 0;
  let queue = Promise.resolve();
  const send = (message) => parent.postMessage(message, "*");
  addEventListener("message", (event) => {
    const m = event.data;
    if (event.source !== parent || !m || m.kind !== "aar-diagram" || typeof m.id !== "string" || typeof m.code !== "string") return;
    const run = async () => {
      if (!api) return send({ kind: "aar-diagram-result", id: m.id, error: "도식 부품을 읽지 못했습니다" });
      const id = "aar-diagram-" + ++seq;
      try {
        api.initialize(m.config && typeof m.config === "object" ? m.config : {});
        // 먼저 문법을 본다(틀린 글을 그리게 하면 부품이 오류 그림을 남긴다).
        await api.parse(m.code);
        const out = await api.render(id, m.code);
        send({ kind: "aar-diagram-result", id: m.id, svg: String(out.svg) });
      } catch (e) {
        send({ kind: "aar-diagram-result", id: m.id, error: String((e && e.message) || e).split("\\n")[0].slice(0, 200) });
      } finally {
        for (const leftover of [id, "d" + id]) {
          const el = document.getElementById(leftover);
          if (el) el.remove();
        }
      }
    };
    queue = queue.then(run, run);
  });
  send({ kind: "aar-diagram-ready", ok: Boolean(api) });
})();
`;

const fail = (status: number, error: string): Response => Response.json({ error }, { status });
const readOnly = (req: Request): Response | null => (req.method === "GET" || req.method === "HEAD" ? null : fail(405, "허용되지 않는 메서드입니다"));

let mermaidFile: Promise<string | null> | null = null;
/** 그리는 부품 파일. 패키지가 없으면 404 이고, 화면은 도식 원문을 글로 보인다. */
export async function mermaidScriptResponse(req: Request): Promise<Response> {
  const refused = readOnly(req);
  if (refused) return refused;
  mermaidFile ??= import("./vendor-mermaid.ts").then((m) => m.default, () => null);
  const path = await mermaidFile;
  const file = path ? Bun.file(path) : null;
  if (!file || !(await file.exists())) return fail(404, "도식 부품이 설치되지 않았습니다");
  return new Response(req.method === "HEAD" ? null : file, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Content-Length": String(file.size), "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff" } });
}

export function diagramRunnerResponse(req: Request): Response {
  const refused = readOnly(req);
  if (refused) return refused;
  return new Response(req.method === "HEAD" ? null : RUNNER_JS, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } });
}

/** 칸의 문서. host 는 요청의 Host 머리다(스크립트를 이 서버에서만 받게 적는다. 출처가 없는 문서에서도 통하게 주소를 그대로 적는다). */
export function diagramFrameResponse(req: Request, host: string): Response {
  const refused = readOnly(req);
  if (refused) return refused;
  const scripts = /^[A-Za-z0-9.\-:[\]]+$/.test(host) ? `'self' http://${host} https://${host}` : "'self'";
  const csp = [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${scripts}`,
    // 부품이 그림 안에 넣는 <style>·style 속성. 바깥 스타일 파일은 받지 못한다.
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
  return new Response(req.method === "HEAD" ? null : FRAME_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-cache" },
  });
}
