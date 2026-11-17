// 도식(Mermaid)을 그리는 격리된 칸. 도식 글은 직원·AI 가 쓴 믿을 수 없는 글이라, 그리는 부품(약 5MB)을 화면 문서에서 돌리지 않는다.
// 화면은 보이지 않는 칸(iframe) 하나에 이 문서를 열고, 도식 글을 메시지로 보내 그림(SVG 글)만 돌려받는다.
// - 칸의 문서는 sandbox(allow-scripts 만)로 열려 출처가 없다: 화면의 DOM·저장소·쿠키·접속 코드에 닿지 못한다.
// - 칸의 보안 정책은 이 서버의 스크립트 두 개만 허락한다. 그림·글꼴·연결·다른 칸은 모두 막는다(도식 글이 어떤 주소도 부르지 못한다).
// - 돌려받은 SVG 는 화면이 <img> 로만 보인다(web/src/lib/mermaid.ts). 함께 돌려받는 부분 목록(이름·글·자리 숫자)은 화면이 다시 검사해 쓴다.
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

/**
 * 칸 안에서 도는 스크립트. 메시지로 받은 도식 글을 하나씩 그려 SVG 글이나 실패 까닭을 돌려준다.
 * 그린 뒤에는 그 그림에서 누를 수 있는 부분(노드·선·묶음)의 이름·글·자리도 함께 돌려준다: 화면은 그림을 <img> 로만 보이므로
 * 그림 안의 요소를 직접 누를 수 없다. 자리는 그림 전체를 1 로 본 비율이고, 이름은 도식 글에 적힌 이름이다(원래 Agent-A 화면이
 * 도식 댓글의 자리로 쓰는 이름과 같은 규칙으로 읽는다). 돌려준 값은 화면이 다시 검사한다(web/src/lib/agent-a-diagram.ts 의 cleanParts).
 * 이름 규칙의 출처는 그 파일 머리에 적었다(plannotator v0.28.48 의 diagramAnchor 규약. 설치된 Mermaid 12.2.0 이 그린 요소로 확인했다).
 * (String.raw: 아래 글은 그대로 스크립트가 된다. 안에서 백틱과 달러-중괄호를 쓰지 않는다.)
 */
const RUNNER_JS = String.raw`(() => {
  "use strict";
  const api = globalThis.mermaid;
  let seq = 0;
  let queue = Promise.resolve();
  const send = (message) => parent.postMessage(message, "*");

  const clean = (text) => String(text == null ? "" : text).replace(/\s+/g, " ").trim().slice(0, 400);
  const familyOf = (svg) => {
    const role = svg.getAttribute("aria-roledescription") || "";
    if (role.indexOf("flowchart") === 0) return "flowchart";
    if (role === "stateDiagram") return "state";
    if (role === "classDiagram") return "class";
    if (role === "er") return "er";
    if (role === "requirement") return "requirement";
    if (role === "sequence") return "sequence";
    return "other";
  };
  // 부분에 보이는 글: 이름표가 있으면 그 글, 없으면 첫 글.
  const labelOf = (el) => clean((el.querySelector(".nodeLabel, .label") || el.querySelector("text") || {}).textContent);
  // 선의 이름 '시작_끝' 을 양 끝으로 가른다. 이름에 밑줄이 들 수 있어, 그려진 노드 이름과 맞는 쪽을 고른다(시작이 긴 것 먼저).
  const splitEnds = (stem, names) => {
    const list = [];
    for (let at = stem.indexOf("_"); at !== -1; at = stem.indexOf("_", at + 1)) if (at > 0 && at < stem.length - 1) list.push({ from: stem.slice(0, at), to: stem.slice(at + 1) });
    const longest = (a, b) => b.from.length - a.from.length;
    return list.filter((c) => names.has(c.from) && names.has(c.to)).sort(longest)[0] || list.filter((c) => names.has(c.from)).sort(longest)[0] || list[0] || null;
  };
  // 그려진 요소의 이름(그릴 때 붙인 머리말을 뗀 것)에서 도식 글의 이름을 읽는다. 갈래마다 규칙이 다르다.
  const identify = (family, el, suffix, names) => {
    const path = el.tagName.toLowerCase() === "path";
    let m = null;
    if (family === "flowchart") {
      if (path) {
        m = /^L_(.+)_\d+$/.exec(suffix);
        const ends = m && splitEnds(m[1], names);
        return ends ? { kind: "edge", from: ends.from, to: ends.to } : null;
      }
      if (el.classList.contains("cluster")) return { kind: "cluster", id: suffix };
      m = /^flowchart-(.+)-\d+$/.exec(suffix);
      return m ? { kind: "node", id: m[1] } : null;
    }
    if (family === "state") {
      if (path) return /^edge\d+$/.test(suffix) ? { kind: "edge", id: suffix } : null;
      m = /^state-(.+)-\d+$/.exec(suffix);
      // 시작·끝 점은 부분이 아니다.
      return m && !/_(?:start|end)$/.test(m[1]) ? { kind: "node", id: m[1] } : null;
    }
    if (family === "class") {
      if (path) {
        m = /^id_(.+)_\d+$/.exec(suffix);
        const ends = m && splitEnds(m[1], names);
        return ends ? { kind: "edge", from: ends.from, to: ends.to } : null;
      }
      m = /^classId-(.+)-\d+$/.exec(suffix);
      return m ? { kind: "node", id: m[1] } : null;
    }
    if (family === "er") {
      if (path) {
        m = /^id_entity-(.+)-\d+_entity-(.+)-\d+_\d+$/.exec(suffix);
        return m ? { kind: "edge", from: m[1], to: m[2] } : null;
      }
      m = /^entity-(.+)-\d+$/.exec(suffix);
      return m ? { kind: "node", id: m[1] } : null;
    }
    if (family === "requirement") {
      if (path) {
        m = /^(.+)-\d+$/.exec(suffix);
        return m ? { kind: "edge", id: m[1] } : null;
      }
      return el.classList.contains("node") ? { kind: "node", id: suffix } : null;
    }
    return null;
  };

  /** 그린 그림을 이 칸 안에 잠깐 놓고 부분의 자리를 잰다. 못 재면 부분 없이 돌려준다(그림은 그대로 보인다). */
  const partsOf = (svgText) => {
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;left:0;top:0;width:1600px;visibility:hidden";
    let family = "other";
    const parts = [];
    try {
      holder.innerHTML = svgText;
      document.body.append(holder);
      const svg = holder.querySelector("svg");
      if (!svg) return { family, parts };
      family = familyOf(svg);
      const base = svg.getBoundingClientRect();
      if (family === "other" || !(base.width > 0 && base.height > 0)) return { family, parts };
      const round = (n) => Math.round(n * 100000) / 100000;
      // 화면 자리(px)를 그림 전체에 대한 비율로. pad 는 둘레에 더하는 여유(px)다.
      const box = (r, pad) => (r.width > 0 || r.height > 0 ? { x: round((r.left - pad - base.left) / base.width), y: round((r.top - pad - base.top) / base.height), w: round((r.width + pad * 2) / base.width), h: round((r.height + pad * 2) / base.height) } : null);
      const rect = (el, pad) => (el ? box(el.getBoundingClientRect(), pad) : null);
      const union = (list) => {
        const rs = list.filter(Boolean).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 || r.height > 0);
        if (!rs.length) return null;
        const left = Math.min.apply(null, rs.map((r) => r.left)), top = Math.min.apply(null, rs.map((r) => r.top));
        return { left, top, width: Math.max.apply(null, rs.map((r) => r.right)) - left, height: Math.max.apply(null, rs.map((r) => r.bottom)) - top };
      };
      // 선을 따라 잘게 나눈 자리들(누르는 자리)과 가운데 자리(표시를 두는 자리).
      const along = (path) => {
        const out = { hits: [], middle: null };
        let len = 0, ctm = null;
        try { len = path.getTotalLength(); ctm = path.getScreenCTM(); } catch (e) { return out; }
        if (!(len > 0) || !ctm) return out;
        const at = (d) => { const p = path.getPointAtLength(d); return { x: p.x * ctm.a + p.y * ctm.c + ctm.e, y: p.x * ctm.b + p.y * ctm.d + ctm.f }; };
        const n = Math.max(1, Math.min(20, Math.ceil(len / 30)));
        let a = at(0);
        for (let i = 1; i <= n; i++) {
          const b = at((len * i) / n);
          out.hits.push(box({ left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x) || 0.01, height: Math.abs(a.y - b.y) || 0.01 }, 7));
          a = b;
        }
        const mid = at(len / 2);
        out.middle = box({ left: mid.x, top: mid.y, width: 0.01, height: 0.01 }, 13);
        return out;
      };
      // 같은 이름의 부분은 하나로 모은다(위아래에 두 번 그려진 참여자, 같은 양 끝의 선).
      const seen = new Map();
      const add = (who, label, mark, hits) => {
        const key = who.kind + "\n" + (who.id || "") + "\n" + (who.from || "") + "\n" + (who.to || "");
        const list = hits.filter(Boolean);
        const old = seen.get(key);
        if (old) { for (const h of list) old.hits.push(h); return; }
        if (!mark || parts.length >= 300) return;
        const part = Object.assign({}, who, { label: clean(label), box: mark, hits: list });
        seen.set(key, part);
        parts.push(part);
      };

      if (family === "sequence") {
        // 참여자: 상자와 생명선. 이름은 도식 글의 참여자 이름이다.
        const actors = Array.from(svg.querySelectorAll("rect.actor[name]"));
        const tops = actors.filter((r) => r.classList.contains("actor-top")).concat(actors.filter((r) => !r.classList.contains("actor-top")));
        for (const r of tops) {
          const name = r.getAttribute("name");
          if (!name) continue;
          const next = r.nextElementSibling;
          add({ kind: "node", id: name }, (next && next.matches("text.actor") ? clean(next.textContent) : "") || name, rect(r, 0), [rect(r, 0)]);
        }
        for (const line of svg.querySelectorAll("line.actor-line[name]")) add({ kind: "node", id: line.getAttribute("name") }, "", null, [rect(line, 6)]);
        // 메시지: 그려진 차례가 이름이다(msg-1…). 글과 선의 수가 다르면 글은 비운다.
        const lines = Array.from(svg.querySelectorAll(".messageLine0, .messageLine1"));
        const texts = Array.from(svg.querySelectorAll("text.messageText"));
        lines.forEach((line, i) => {
          const text = texts.length === lines.length ? texts[i] : null;
          const from = line.getAttribute("data-from"), to = line.getAttribute("data-to");
          const who = { kind: "edge", id: "msg-" + (i + 1) };
          if (from && to) { who.from = from; who.to = to; }
          add(who, text ? text.textContent : "", box(union([line, text]) || line.getBoundingClientRect(), 4), [rect(line, 7), rect(text, 2)]);
        });
        // 메모
        Array.from(svg.querySelectorAll("rect.note")).forEach((note, i) => {
          const text = note.parentElement ? note.parentElement.querySelector("text.noteText") : null;
          add({ kind: "node", id: "note-" + (i + 1) }, text ? text.textContent : "", rect(note, 0), [rect(note, 0)]);
        });
        // 틀(loop·alt·opt…): 테두리 선과 이름표를 누른다. 안쪽은 누르는 자리가 아니다.
        const frames = [];
        for (const line of svg.querySelectorAll("line.loopLine")) if (line.parentElement && frames.indexOf(line.parentElement) === -1) frames.push(line.parentElement);
        frames.forEach((g, i) => {
          const a = g.querySelector("text.labelText"), b = g.querySelector("text.loopText");
          const hits = Array.from(g.querySelectorAll("line.loopLine")).map((l) => rect(l, 6));
          for (const el of g.querySelectorAll("polygon.labelBox, text.labelText, text.loopText")) hits.push(rect(el, 2));
          add({ kind: "cluster", id: "frame-" + (i + 1) }, (a ? a.textContent : "") + " " + (b ? b.textContent : ""), rect(g, 0), hits);
        });
        return { family, parts };
      }

      const prefix = svg.id + "-";
      const suffixOf = (el) => (el.id && el.id.indexOf(prefix) === 0 ? el.id.slice(prefix.length) : null);
      const names = new Set();
      const named = family === "flowchart" ? /^flowchart-(.+)-\d+$/ : family === "class" ? /^classId-(.+)-\d+$/ : null;
      if (named) for (const node of svg.querySelectorAll("g.node")) { const m = named.exec(suffixOf(node) || ""); if (m) names.add(m[1]); }
      // 선에 붙은 글은 그 선의 이름을 data-id 로 싣는다.
      const edgeLabels = new Map();
      for (const g of svg.querySelectorAll(".label[data-id]")) if (!edgeLabels.has(g.getAttribute("data-id"))) edgeLabels.set(g.getAttribute("data-id"), g);
      for (const el of svg.querySelectorAll("g.node, g.cluster, g.statediagram-cluster, path.flowchart-link, path.transition, path.relation, path.relationshipLine")) {
        const suffix = suffixOf(el);
        const who = suffix === null ? null : identify(family, el, suffix, names);
        if (!who) continue;
        if (who.kind !== "edge") { add(who, labelOf(el), rect(el, 0), [rect(el, 0)]); continue; }
        const text = edgeLabels.get(suffix) || null;
        const textBox = text ? rect(text, 4) : null;
        const line = along(el);
        add(who, text ? text.textContent : "", textBox || line.middle, line.hits.concat([textBox]));
      }
    } catch (e) {
      return { family, parts };
    } finally {
      holder.remove();
    }
    return { family, parts };
  };

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
        const svg = String(out.svg);
        const found = partsOf(svg);
        send({ kind: "aar-diagram-result", id: m.id, svg, family: found.family, parts: found.parts });
      } catch (e) {
        send({ kind: "aar-diagram-result", id: m.id, error: String((e && e.message) || e).split("\n")[0].slice(0, 200) });
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
