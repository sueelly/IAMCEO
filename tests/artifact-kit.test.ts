// 아티팩트 문서 조립(shared/artifact-kit.ts). 실제 브라우저에서의 격리는 tests/artifact.browser.ts 가 본다.
import { describe, expect, test } from "bun:test";
import { ARTIFACT_CSP, ARTIFACT_KIT_CSS, ARTIFACT_SANDBOX, ARTIFACT_STATIC_CSP, ARTIFACT_STATIC_SANDBOX, buildArtifactSrcdoc, isScriptlessArtifact } from "../shared/artifact-kit.ts";
import { readReportedAnchor } from "../web/src/components/ArtifactFrame.tsx";

const META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;

describe("buildArtifactSrcdoc", () => {
  test("CSP 는 요구한 값이고 지켜야 할 것을 다 막는다", () => {
    expect(ARTIFACT_CSP).toBe("default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'");
  });

  test("작성자 스크립트보다 먼저 WebRTC 생성자를 지운다", () => {
    const out = buildArtifactSrcdoc("<p>본문</p>");
    expect(out.indexOf("RTCPeerConnection")).toBeGreaterThan(0);
    expect(out.indexOf("RTCPeerConnection")).toBeLessThan(out.indexOf("<p>본문</p>"));
  });

  test("순서: 메타 → 키트 → 높이 보고 → 작성자", () => {
    const out = buildArtifactSrcdoc("<p>본문</p>");
    const order = [out.indexOf(META), out.indexOf("<style>"), out.indexOf("iamceoHeight"), out.indexOf("<p>본문</p>")];
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out.startsWith('<!doctype html><html lang="ko"><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  const TRICKS = [
    "<!doctype html><html><head><meta http-equiv='Content-Security-Policy' content=\"default-src *\"><title>x</title></head><body>글</body></html>",
    "--><script>1</script>",
    "</style></head><script>1</script>",
    "<!--",
    "</script><script>1</script>",
    "<base href='https://evil.example/'>",
    "﻿<!DOCTYPE html>",
    "\0<meta http-equiv=refresh content='0;url=https://evil.example'>",
  ];
  test.each(TRICKS)("어떤 작성자 글이어도 메타가 먼저다: %s", (html) => {
    const out = buildArtifactSrcdoc(html);
    const head = out.slice(0, out.indexOf("</head><body>"));
    expect(out.indexOf(META)).toBeLessThan(out.indexOf("<style>"));
    // 앞머리는 작성자 글과 상관없이 늘 같다.
    expect(head).toBe(buildArtifactSrcdoc("").slice(0, buildArtifactSrcdoc("").indexOf("</head><body>")));
    expect(out).not.toContain("\0");
  });

  test("제목·언어는 깨지지 않게 넣는다", () => {
    const out = buildArtifactSrcdoc("x", { title: '</title><script>alert(1)</script>"', lang: 'ko"><script>' });
    expect(out).not.toContain("</title><script>alert(1)");
    expect(out).toContain("&lt;/title&gt;");
    expect(out).toContain('<html lang="ko">');
  });

  test("키트: 모든 조각이 있고 작성자 CSS 가 덮을 수 있게 우선순위가 0 이다", () => {
    for (const piece of [".card", ".grid", ".callout", ".kpi", ".steps", ".tag", ".compare", "table", "pre", "h1", "@media"]) expect(ARTIFACT_KIT_CSS).toContain(piece);
    for (const line of ARTIFACT_KIT_CSS.split("\n")) if (!line.startsWith("@media")) expect(line.startsWith(":where(")).toBe(true);
    expect(ARTIFACT_KIT_CSS).not.toContain("url(");
  });

  test("키트: 기본은 라이트다(웹 자료 보기와 같은 바탕·글자)", () => {
    expect(ARTIFACT_KIT_CSS).toContain(":where(html){color-scheme:light;");
    expect(ARTIFACT_KIT_CSS).toContain("background:#FBFAFE;color:#17132B;");
    expect(ARTIFACT_KIT_CSS).toContain(":where(a){color:#5B3FD9}");
    // 어두운 판 시절 값이 남지 않는다.
    for (const dark of ["color-scheme:dark", "#090713", "#F5F2FF", "#C2BBDF", "#B9A8FF", "rgba(255,255,255"]) expect(ARTIFACT_KIT_CSS).not.toContain(dark);
  });
});

describe("키트 화면 부품 12개", () => {
  test("흔한 클래스 이름은 부품 짜임 안에서만 잡는다(예전 자료의 .col·.bar·.status·.page 를 바꾸지 않는다)", () => {
    for (const bare of [".page", ".src", ".owner", ".toc", ".find", ".no", ".hero", ".delta", ".bars", ".bar", ".ticks", ".cols", ".col", ".ba", ".why", ".rec", ".opts", ".gantt", ".status", ".dg"]) {
      expect([bare, new RegExp(`(?:^|[(,\\s])${bare.replaceAll(".", "\\.")}(?=[){,:\\s>.\\[])`, "m").test(ARTIFACT_KIT_CSS)]).toEqual([bare, false]);
    }
  });

  test("부품마다 선택자가 있고, 예전 조각은 그대로다", () => {
    for (const piece of [".page", ".src", ".owner", ".toc", ".find", ".no", ".hero", ".delta", ".bars", ".bar", ".has-limit", ".ticks", ".cols", ".cols-plot", ".col", ".cols-x", ".ba", ".ba-before", ".ba-label", "sup.n", ".why", ".rec", ".rec-head", ".rec-cost", ".tag.pick", ".rec-cell", ".opts", ".gantt", ".g-row", ".g-axis", ".status", ".dg", ".dg-box", ".dg-t", ".dg-s", ".dg-line", ".dg-head", ".dg-l"]) expect([piece, new RegExp(`${piece.replaceAll(".", "\\.")}(?![\\w-])`).test(ARTIFACT_KIT_CSS)]).toEqual([piece, true]);
    for (const old of [":where(.compare>.pick){border-color:rgb(122 91 255 / .55);background:rgb(122 91 255 / .07)}", ":where(.tag.warn){background:rgb(255 154 77 / .08);border-color:rgb(255 154 77 / .35);color:#A8530A}"]) expect(ARTIFACT_KIT_CSS).toContain(old);
  });

  test("색은 키트 값만 쓴다(주황·빨강·초록·보라·회색)", () => {
    const hex = new Set(ARTIFACT_KIT_CSS.match(/#[0-9A-Fa-f]{3,8}\b/g)!.map((c) => c.toUpperCase()));
    const allowed = ["#FBFAFE", "#17132B", "#4A4566", "#5F5983", "#5B3FD9", "#7A5BFF", "#A8530A", "#FF9A4D", "#FFF1E6", "#C2372E", "#FF6B60", "#0B7F55", "#20B97C", "#F6F4FC", "#FFF"];
    for (const c of hex) expect(allowed).toContain(c);
  });

  test("상태 위계: 태그 다음에 권장 태그가 와서 덮는다", () => {
    expect(ARTIFACT_KIT_CSS.indexOf(":where(.tag.pick)")).toBeGreaterThan(ARTIFACT_KIT_CSS.indexOf(":where(.tag){"));
  });
});

describe("# 이동(맞춤 칸)", () => {
  test("높이 보고 스크립트가 # 대상 위치를 부모에게 알린다", () => {
    const out = buildArtifactSrcdoc("<h2 id='a'>가</h2>");
    expect(out).toContain("iamceoAnchor");
    // 바깥 링크는 여전히 막고 알린다
    expect(out).toContain("iamceoLink");
  });

  test("부모는 수이고 범위 안인 값만, 칸 높이 안으로 줄여 쓴다", () => {
    expect(readReportedAnchor(120.4, 600)).toBe(120);
    expect(readReportedAnchor(5000, 600)).toBe(599);
    expect(readReportedAnchor(0, 600)).toBe(0);
    for (const bad of [-1, NaN, Infinity, 2e6, "100", null, undefined, { y: 1 }]) expect(readReportedAnchor(bad, 600)).toBeNull();
  });
});

describe("스크립트 없는 자료", () => {
  const SAFE = [
    "<h1>결론</h1><p class='owner'><b>대표 차례</b><span>골라 주세요</span></p>",
    "<ol class='toc'><li>① 결론</li></ol><h2 id='s1'>결론</h2><a href='#s1'>위로</a><a href='https://example.com/a?b=1&amp;c=2'>바깥</a>",
    "<style>.x{color:red}</style><details><summary>세부</summary>글</details>",
    "<svg viewBox='0 0 10 10'><rect width='10' height='10' fill='#fff'/></svg><img src='data:image/png;base64,AAAA' alt=''>",
    "<p>description · transcript · subscription · 'on' 이라는 낱말 · button=버튼</p>",
    "<table><tr><th>항목</th></tr></table><noscript>글</noscript><formula>x</formula>",
  ];
  test.each(SAFE)("바로 그린다: %s", (html) => {
    expect(isScriptlessArtifact(html)).toBe(true);
  });

  const ACTIVE = [
    "<script>1</script>",
    "<SCRIPT src=x></SCRIPT>",
    "<svg><script>1</script></svg>",
    "<img src=x onerror=alert(1)>",
    "<img/onerror=alert(1)>",
    '<a href="x"onclick="y">a</a>',
    "<body onload = 'x'>",
    "<a href='javascript:alert(1)'>a</a>",
    "<a href='JaVaScRiPt:alert(1)'>a</a>",
    "<a href='java\tscript:alert(1)'>a</a>",
    "<a href='jav&#x61;script:alert(1)'>a</a>",
    "<a href='&#106;avascript&#58;alert(1)'>a</a>",
    "<a href='&#0000106avascript:alert(1)'>a</a>",
    "<a href='javascript&colon;alert(1)'>a</a>",
    "<a href='java&Tab;script:alert(1)'>a</a>",
    "<a href='vbscript:x'>a</a>",
    "<a href='data:text/html,<b>x</b>'>a</a>",
    "<svg><a xlink:href='javascript:1'><text>x</text></a></svg>",
    "<svg><animate attributeName='href' to='javascript:1'/></svg>",
    "<iframe srcdoc='x'></iframe>",
    "<frameset></frameset>",
    "<object data='x'></object>",
    "<embed src='x'>",
    "<form action='x'><input></form>",
    "<base href='https://evil.example/'>",
    "<meta http-equiv='refresh' content='0;url=https://evil.example'>",
    "<meta name='x>' HTTP-EQUIV=refresh content='0'>",
    "<scr\0ipt>1</script>",
    "<div><template shadowrootmode='open'><a href='#sec'>a</a></template></div><h2 id='sec'>s</h2>",
    "<div><template SHADOWROOT=open><p>x</p></template></div>",
  ];
  test.each(ACTIVE)("'실행' 칸으로 보낸다: %s", (html) => {
    expect(isScriptlessArtifact(html)).toBe(false);
  });

  test("칸 값: allow-scripts 와 allow-same-origin 을 한 칸에 두지 않는다", () => {
    expect(ARTIFACT_STATIC_SANDBOX).toBe("allow-same-origin");
    expect(ARTIFACT_STATIC_SANDBOX).not.toContain("allow-scripts");
    expect(ARTIFACT_SANDBOX).not.toContain("allow-same-origin");
    for (const flag of ["allow-top-navigation", "allow-popups", "allow-forms", "allow-downloads", "allow-modals"]) expect(ARTIFACT_STATIC_SANDBOX).not.toContain(flag);
  });

  test("정책: 스크립트·요청·blob 을 모두 막는다", () => {
    expect(ARTIFACT_STATIC_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'");
    expect(ARTIFACT_STATIC_CSP).not.toContain("script-src");
    expect(ARTIFACT_STATIC_CSP).not.toContain("blob:");
  });

  test("문서: 정책이 맨 앞이고 스크립트를 넣지 않으며, 작성자 글과 상관없이 앞머리가 같다", () => {
    const out = buildArtifactSrcdoc("<p>본문</p>", { scripts: false });
    expect(out.startsWith(`<!doctype html><html lang="ko"><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_STATIC_CSP}">`)).toBe(true);
    expect(out).not.toContain("<script");
    expect(out).not.toContain(ARTIFACT_CSP);
    expect(out.indexOf("<style>")).toBeLessThan(out.indexOf("<p>본문</p>"));
    const headOf = (doc: string) => doc.slice(0, doc.indexOf("</head><body>"));
    for (const html of ["<!doctype html><html><head><title>x</title></head><body>글</body></html>", "--></style></head>", "<!--"]) expect(headOf(buildArtifactSrcdoc(html, { scripts: false }))).toBe(headOf(buildArtifactSrcdoc("", { scripts: false })));
    // 중첩 칸·link 는 이 길에서도 이름을 바꾼다
    expect(buildArtifactSrcdoc("<link rel=preconnect href='https://x.test'>", { scripts: false })).toContain("<x-blocked-link");
  });

  test("스크립트 칸 문서는 그대로다(기본값)", () => {
    expect(buildArtifactSrcdoc("x")).toBe(buildArtifactSrcdoc("x", { scripts: true }));
    expect(buildArtifactSrcdoc("x")).toContain(`content="${ARTIFACT_CSP}"`);
  });
});
