// 아티팩트(자료의 한 페이지 HTML)를 격리 칸에 그리는 원본. 서버와 화면이 함께 쓴다. 브라우저에서도 돌아야 하므로 node 모듈을 쓰지 않는다.
//
// 그리는 법(화면):
//   <iframe sandbox="allow-scripts" src="/artifact-frame"> 를 만든다. 부모 페이지의 CSP(script-src 'self')를 물려받는 srcdoc 은 인라인 스크립트가 돌지 않는다.
//   칸이 {iamceoFrameReady:true} 를 보내면(e.source 확인) GET /api/files/:id/artifact 로 받은 html 을
//   contentWindow.postMessage({iamceoSrcdoc: buildArtifactSrcdoc(html, {title})}, "*") 로 넣는다.
//   칸은 {iamceoHeight:n}·{iamceoLink:url}·{iamceoAnchor:y}·{iamceoEscape:true} 를 보낸다(e.source 확인·값 검사 뒤에만 쓴다. 작성자 글도 보낼 수 있다). sandbox 에 allow-same-origin·allow-top-navigation 을 넣지 않는다.
//
// 스크립트 없는 자료(isScriptlessArtifact)는 '실행' 없이 바로 그린다:
//   <iframe sandbox="allow-same-origin" srcdoc={buildArtifactSrcdoc(html, {title, scripts:false})}>.
//   allow-scripts 가 없어 칸 안에서는 어떤 스크립트도 돌지 않는다(작성자 글·이벤트 속성·javascript: 모두). 같은 출처는 부모가 높이를 재고
//   표를 감싸고 링크·# 이동을 대신 받으려고 둔다. 두 플래그를 함께 주면 칸이 sandbox 를 벗길 수 있으므로 절대 함께 두지 않는다.
//   남는 길: 칸 안 링크를 누르면 칸이 넘어가려 한다(srcdoc 의 # 링크는 부모 주소로 풀린다). 부모가 load 때 붙이는 click 가로채기가 막는다.
//   그 전에 누르면 같은 출처 화면이 스크립트 없이 칸에 뜨거나(바깥 주소는 부모 CSP frame-src 가 막는다) 할 뿐, 스크립트도 요청도 생기지 않는다.
//   검사(isScriptlessArtifact)는 경계가 아니라 길 고르기다. 경계는 allow-scripts 없는 sandbox 와 ARTIFACT_STATIC_CSP 다.

/**
 * 칸 안에서 쓸 수 있는 것. 일반 요청(fetch·이미지 등)·폼 제출은 막고, 인라인 스크립트·스타일과 data: 자원만 허용한다.
 * CSP 로 못 막는 길이 있다: WebRTC(STUN UDP)는 Chromium·WebKit 모두 나가고 WebKit 은 preconnect TCP 도 나간다(실측). 그래서 앞머리에서 RTCPeerConnection 을 지우고, 중첩 칸(새 realm)과 link 를 글에서 무력화하고 스크립트로 넣어도 지운다. 중첩 칸은 서로 다른 불투명 출처라 부모 스크립트가 꺼내 쓰지 못한다. 그래도 WebKit 은 스크립트가 넣은 link 로 넣는 즉시 TCP 로 접속하고(실측, 요청 내용 없음) 이는 페이지 쪽에서 막을 방법이 없으므로 민감한 데이터는 아티팩트에 싣지 않는다.
 */
export const ARTIFACT_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** 빈 칸의 주소와 iframe sandbox 값. */
export const ARTIFACT_FRAME_PATH = "/artifact-frame";
export const ARTIFACT_SANDBOX = "allow-scripts";

/**
 * 스크립트 없는 자료의 칸. allow-scripts 를 넣지 않는다(이 값에 allow-scripts 를 더하는 순간 칸이 부모 출처의 스크립트가 된다).
 * 정책은 맥·아이폰 앱(ArtifactKit.policy)과 같은 결이다. script-src 는 default-src 'none' 을 따르고, blob: 도 받지 않는다(같은 출처라 부모의 blob 을 그릴 수 있게 되므로).
 */
export const ARTIFACT_STATIC_SANDBOX = "allow-same-origin";
export const ARTIFACT_STATIC_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

/** 스크립트 없이 열 수 있는지 볼 때 '움직이는 것'으로 치는 태그. 칸·플러그인·폼·base 는 하는 일이 없어도 이 길로 보내지 않는다. */
const ACTIVE_TAG = /<\/?\s*(script|iframe|frame|frameset|object|embed|applet|form|portal|fencedframe|base|isindex)(?=[\s/>]|$)/i;
/** 이벤트 속성(onclick 등). 속성 이름은 문자 참조를 풀지 않으므로 글자 그대로 본다. 이름 앞에 올 수 있는 것은 공백·/·따옴표다. */
const EVENT_ATTR = /[\s/"']on[a-z]+\s*=/i;
/** 숫자 문자 참조(세미콜론 없어도 된다)와 URL 을 쪼개는 데 쓰이는 이름 참조. */
const CHAR_REF = /&#(?:x([0-9a-f]+)|(\d+));?|&(colon|tab|newline);/gi;
const SCRIPT_SCHEME = /(?:java|vb|live)script:|data:text\/html/i;

/**
 * '실행' 없이 바로 그려도 되는 자료인지. 스크립트·이벤트 속성·javascript: 주소·칸·object·embed·form·base·http-equiv(새로고침 등)가
 * 하나라도 있으면 false 다. 글자로만 보고, 헷갈리면 false(=예전처럼 '실행' 칸)로 기운다.
 *
 * 이 검사는 안전의 경계가 아니다. 경계는 allow-scripts 없는 sandbox 다(이 검사를 속여도 칸 안에서 스크립트는 돌지 않는다).
 * 이 검사는 (1) 스크립트가 있어야 제대로 보이는 자료를 '실행' 길로 보내고 (2) 같은 출처 칸에 움직이는 것을 아예 들이지 않는 이중 장치다.
 */
export function isScriptlessArtifact(html: string): boolean {
  const text = html.replaceAll("\0", "");
  if (ACTIVE_TAG.test(text) || EVENT_ATTR.test(text) || /http-equiv/i.test(text)) return false;
  const decoded = text.replace(CHAR_REF, (_, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (named) return named.toLowerCase() === "colon" ? ":" : "";
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
  // 주소 안의 공백·제어 문자는 브라우저가 지우고 읽는다. 모두 지운 뒤 본다(글 속 'java script:' 도 걸린다. 그 쪽으로 기우는 것이 맞다).
  return !SCRIPT_SCHEME.test(decoded.replace(/[\u0000-\u0020\u007f-\u009f]/g, ""));
}

// 모든 선택자를 :where 로 감싸 우선순위를 0 으로 둔다. 작성자 CSS 가 무엇이든 키트를 덮는다.
// 기본은 라이트다. 웹 자료 보기와 같은 결(바탕 #FBFAFE, 글자 #17132B·#4A4566, 선 rgb(23 19 43 / .08~.1))로 맞춘다.
// 상태 글자(#A8530A·#C2372E·#0B7F55)는 옅은 바닥 위에서도 대비 4.5 를 넘도록 바닥 알파를 낮게 둔다.
export const ARTIFACT_KIT_CSS = `
:where(*,*::before,*::after){box-sizing:border-box}
:where(html){color-scheme:light;-webkit-text-size-adjust:100%}
:where(body){margin:0;padding:24px;background:#FBFAFE;color:#17132B;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Segoe UI",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
:where(h1,h2,h3,h4){margin:1.6em 0 .6em;line-height:1.3;font-weight:650;color:#17132B}
:where(h1){font-size:1.6rem;margin-top:0}
:where(h2){font-size:1.25rem}
:where(h3){font-size:1.05rem}
:where(h4){font-size:.95rem;color:#4A4566}
:where(p,ul,ol,dl,blockquote,pre,table,figure){margin:0 0 1em}
:where(ul,ol){padding-left:1.4em}
:where(li+li){margin-top:.25em}
:where(a){color:#5B3FD9}
:where(strong){color:#17132B}
:where(hr){border:0;border-top:1px solid rgb(23 19 43 / .1);margin:1.5em 0}
:where(blockquote){padding:.2em 0 .2em 1em;border-left:3px solid rgb(122 91 255 / .45);color:#4A4566}
:where(img,svg,video,canvas){max-width:100%;height:auto}
:where(code,kbd,samp){font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgb(23 19 43 / .05);padding:.1em .35em;border-radius:5px}
:where(pre){padding:14px 16px;background:rgb(23 19 43 / .04);border:1px solid rgb(23 19 43 / .08);border-radius:12px;overflow:auto}
:where(pre code){background:none;padding:0}
:where(table){width:100%;border-collapse:collapse;font-size:.93em;display:block;overflow-x:auto}
:where(.kit-table){margin:0 0 1em;overflow-x:auto}
:where(.kit-table>table){display:table;margin:0}
:where(th,td){padding:9px 12px;border-bottom:1px solid rgb(23 19 43 / .08);text-align:left;vertical-align:top;overflow-wrap:break-word}
:where(th){color:#4A4566;font-weight:600;background:#F6F4FC;white-space:nowrap}
:where(.card){padding:18px 20px;margin:0 0 14px;background:#fff;border:1px solid rgb(23 19 43 / .08);border-radius:16px;box-shadow:0 1px 2px rgb(40 24 110 / .05),0 10px 28px -18px rgb(70 46 180 / .25)}
:where(.card>:last-child,.callout>:last-child){margin-bottom:0}
:where(.card>:first-child,.callout>:first-child){margin-top:0}
:where(.grid){display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:0 0 14px}
:where(.grid>.card){margin:0}
:where(.callout){padding:14px 16px;margin:0 0 14px;background:rgb(122 91 255 / .08);border:1px solid rgb(122 91 255 / .22);border-left-width:4px;border-left-color:#7A5BFF;border-radius:12px}
:where(.callout.warn){background:rgb(255 154 77 / .08);border-color:rgb(255 154 77 / .4);border-left-color:#FF9A4D;color:#A8530A}
:where(.callout.bad){background:rgb(255 107 96 / .08);border-color:rgb(255 107 96 / .4);border-left-color:#FF6B60;color:#C2372E}
:where(.callout.good){background:rgb(32 185 124 / .06);border-color:rgb(32 185 124 / .4);border-left-color:#20B97C;color:#0B7F55}
:where(.kpi){display:flex;flex-direction:column;gap:4px;padding:16px 18px;background:#fff;border:1px solid rgb(23 19 43 / .08);border-radius:16px;box-shadow:0 1px 2px rgb(40 24 110 / .05),0 10px 28px -18px rgb(70 46 180 / .25)}
:where(.kpi b,.kpi strong){font-size:1.7rem;line-height:1.2;font-weight:680;color:#17132B;font-variant-numeric:tabular-nums}
:where(.kpi small,.kpi span){color:#4A4566;font-size:.85em}
:where(.steps){list-style:none;counter-reset:step;padding:0;margin:0 0 14px}
:where(.steps>li){counter-increment:step;position:relative;padding:0 0 14px 40px;margin:0}
:where(.steps>li)::before{content:counter(step);position:absolute;left:0;top:0;width:26px;height:26px;display:grid;place-items:center;border-radius:50%;background:rgb(122 91 255 / .12);color:#5B3FD9;font-size:.82em;font-weight:650}
:where(.steps>li:not(:last-child))::after{content:"";position:absolute;left:12.5px;top:30px;bottom:4px;width:1px;background:rgb(23 19 43 / .12)}
:where(.tag){display:inline-block;padding:.1em .6em;border-radius:999px;font-size:.8em;line-height:1.6;background:rgb(23 19 43 / .05);color:#4A4566;border:1px solid rgb(23 19 43 / .08)}
:where(.tag.good){background:rgb(32 185 124 / .06);border-color:rgb(32 185 124 / .3);color:#0B7F55}
:where(.tag.warn){background:rgb(255 154 77 / .08);border-color:rgb(255 154 77 / .35);color:#A8530A}
:where(.tag.bad){background:rgb(255 107 96 / .08);border-color:rgb(255 107 96 / .35);color:#C2372E}
:where(.compare){display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:0 0 14px}
:where(.compare>*){padding:16px 18px;margin:0;background:#fff;border:1px solid rgb(23 19 43 / .08);border-radius:14px}
:where(.compare>.pick){border-color:rgb(122 91 255 / .55);background:rgb(122 91 255 / .07)}
:where(.compare>*>:last-child){margin-bottom:0}
:where(.compare>*>:first-child){margin-top:0}
:where(.flow){display:flex;flex-wrap:wrap;gap:10px 26px;list-style:none;padding:0;margin:0 0 14px}
:where(.flow>*){position:relative;flex:1 1 130px;margin:0;padding:12px 14px;background:#fff;border:1px solid rgb(23 19 43 / .08);border-radius:12px}
:where(.flow>*:not(:last-child))::after{content:"→";position:absolute;right:-20px;top:50%;transform:translateY(-50%);color:#5F5983}
:where(.flow>*>:last-child){margin-bottom:0}
:where(.flow>*>:first-child){margin-top:0}
:where(button){font:inherit;color:inherit}
:where(.tabs){display:flex;flex-wrap:wrap;gap:4px;padding:4px;margin:0 0 14px;background:rgb(23 19 43 / .04);border:1px solid rgb(23 19 43 / .08);border-radius:14px}
:where(.tabs>button){flex:1 1 auto;min-height:44px;padding:0 14px;background:none;border:0;border-radius:10px;color:#4A4566;font-weight:600;cursor:pointer}
:where(.tabs>button:hover){background:rgb(122 91 255 / .07)}
:where(.tabs>button[aria-selected="true"]){background:#fff;color:#5B3FD9;box-shadow:0 6px 16px -6px rgb(122 91 255 / .55),0 0 0 1px rgb(122 91 255 / .22)}
@media (max-width:520px){:where(body){padding:16px;font-size:14.5px}:where(h1){font-size:1.35rem}:where(.grid,.compare){grid-template-columns:1fr}:where(.flow){flex-direction:column;gap:22px}:where(.flow>*){flex:none}:where(.flow>*:not(:last-child))::after{content:"↓";right:auto;left:50%;top:auto;bottom:-22px;transform:translateX(-50%)}}
:where(.page){max-width:760px;margin-inline:auto}
:where(.page>h2){margin-top:40px}
:where(.src){margin:8px 0 0;font-size:.8em;color:#5F5983}
:where(.owner){display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin:0 0 14px;padding:12px 16px;background:rgb(255 154 77 / .1);border:1px solid rgb(255 154 77 / .45);border-radius:12px;color:#17132B}
:where(.owner)::before{content:"";flex:none;align-self:center;width:9px;height:9px;border-radius:50%;background:#FF9A4D}
:where(.owner>b){color:#A8530A}
:where(.toc){display:flex;flex-wrap:wrap;gap:2px 14px;list-style:none;padding:0;margin:0 0 4px;font-size:.86em;color:#4A4566}
:where(.toc>li){margin:0}
:where(.find){margin:0 0 14px;font-size:.82em;color:#5F5983}
:where(.no){color:#5F5983;font-weight:600}
:where(.hero){display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px;margin:0 0 14px}
:where(.hero>b){font-size:3rem;line-height:1.05;font-weight:700;color:#17132B;white-space:nowrap}
:where(.hero>span){flex:1 1 220px;min-width:0;color:#4A4566}
:where(.delta){white-space:nowrap;font-variant-numeric:tabular-nums;color:#4A4566}
:where(.delta>b){color:#17132B;font-weight:680}
:where(.delta>small){font-size:.85em;color:#5F5983}
:where(.bars){display:grid;gap:10px;margin:0 0 14px;max-width:640px}
:where(.bars>figcaption){font-weight:650;margin:0 0 2px}
:where(.bar){display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;font-size:.88em}
:where(.bar>b){font-variant-numeric:tabular-nums;font-weight:650}
:where(.bar)::after{content:"";grid-column:1/-1;height:10px;width:calc(var(--v) / var(--max) * 100%);min-width:2px;border-radius:0 4px 4px 0;background:rgb(23 19 43 / .25)}
:where(.bar.is-key)::after{background:#17132B}
:where(.bar.is-rec)::after{background:#7A5BFF}
:where(.bar){position:relative}
:where(.has-limit .bar)::before{content:"";position:absolute;bottom:-3px;left:calc(var(--limit) / var(--max) * 100% - 1px);width:2px;height:16px;border-radius:1px;background:#17132B}
:where(.ticks){display:flex;justify-content:space-between;margin:0;padding-top:4px;border-top:1px solid rgb(23 19 43 / .15);font-size:.75em;color:#5F5983;font-variant-numeric:tabular-nums}
:where(.cols){margin:0 0 14px;max-width:520px}
:where(.cols>figcaption){font-weight:650;margin:0 0 10px}
:where(.cols-plot){display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:12px;align-items:end;height:150px;border-bottom:1px solid rgb(23 19 43 / .3)}
:where(.col){display:flex;flex-direction:column;align-items:center;gap:4px;font-size:.88em}
:where(.col>b){font-variant-numeric:tabular-nums;font-weight:650}
:where(.col)::after{content:"";width:min(44px,80%);height:calc(var(--v) / var(--max) * 120px);min-height:2px;border-radius:4px 4px 0 0;background:rgb(23 19 43 / .25)}
:where(.col.is-key)::after{background:#17132B}
:where(.cols-x){display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:12px;margin:6px 0 0;text-align:center;font-size:.8em;line-height:1.4;color:#4A4566}
:where(.ba){display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:0 0 14px}
:where(.ba>*){margin:0;padding:14px 16px;background:#fff;border:1px solid rgb(23 19 43 / .1);border-radius:12px}
:where(.ba>.ba-before){background:transparent;color:#4A4566}
:where(.ba>*>p){margin:0}
:where(.ba-label){display:block;margin:0 0 6px;font-size:.8em;font-weight:650;color:#5F5983;letter-spacing:.02em}
:where(.ba del){color:#5F5983;text-decoration-thickness:1.5px}
:where(.ba ins){text-decoration:none;font-weight:650;color:#17132B;background:rgb(23 19 43 / .07);box-shadow:inset 0 -2px 0 #17132B;padding:0 2px;border-radius:3px}
:where(sup.n){font-size:.68em;font-weight:700;color:#17132B;margin-left:1px}
:where(.why){margin:0 0 14px;padding-left:1.4em;font-size:.93em;color:#4A4566}
@media (max-width:520px){:where(.ba){grid-template-columns:1fr;gap:8px}}
:where(.rec){margin:0 0 14px;padding:16px 18px;background:rgb(122 91 255 / .07);border:1px solid rgb(122 91 255 / .5);border-radius:14px}
:where(.rec>p){margin:0 0 4px}
:where(.rec>.rec-head){margin:0 0 8px;font-size:1.05em;font-weight:650;color:#17132B}
:where(.rec>.rec-cost){margin:10px 0 0;padding-top:10px;border-top:1px solid rgb(122 91 255 / .2);color:#4A4566;font-size:.93em}
:where(.rec>:last-child){margin-bottom:0}
:where(.tag.pick){background:#fff;border-color:rgb(122 91 255 / .4);color:#5B3FD9;font-weight:650}
:where(.rec-cell){background:rgb(122 91 255 / .06)}
:where(.opts){list-style:none;padding:0;margin:0 0 14px;display:grid;gap:6px;font-size:.93em;color:#4A4566}
:where(.opts>li){margin:0;padding:10px 14px;border:1px solid rgb(23 19 43 / .1);border-radius:12px}
:where(.opts b){color:#17132B;margin-right:6px}
:where(.gantt){display:grid;gap:10px;margin:0 0 14px;max-width:640px}
:where(.gantt>figcaption){font-weight:650;margin:0 0 2px}
:where(.g-row){display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;font-size:.88em}
:where(.g-row>em){font-style:normal;color:#4A4566;font-variant-numeric:tabular-nums}
:where(.g-row>i){grid-column:1/-1;position:relative;display:block;height:14px;border-radius:4px;background:repeating-linear-gradient(90deg,transparent 0 calc(100% / var(--days) - 1px),rgb(23 19 43 / .09) calc(100% / var(--days) - 1px) calc(100% / var(--days))),rgb(23 19 43 / .035)}
:where(.g-row>i)::before{content:"";position:absolute;top:0;bottom:0;left:calc(var(--s) / var(--days) * 100%);width:calc((var(--e) - var(--s)) / var(--days) * 100%);border-radius:4px;background:rgb(23 19 43 / .45)}
:where(.g-row.is-rec>i)::before{background:#7A5BFF}
:where(.g-row.is-opt>i)::before{background:transparent;border:1.5px dashed #5F5983}
:where(.g-row.is-owner>i)::before{top:1px;bottom:auto;width:12px;height:12px;margin-left:1px;border-radius:2px;transform:rotate(45deg);background:#FF9A4D}
:where(.g-axis){display:flex;justify-content:space-between;margin:0;font-size:.78em;color:#5F5983;font-variant-numeric:tabular-nums}
:where(.status){list-style:none;padding:0;margin:0 0 14px;display:grid;gap:6px}
:where(.status>li){display:flex;gap:10px;align-items:baseline;margin:0;padding:10px 14px;background:#fff;border:1px solid rgb(23 19 43 / .08);border-radius:12px}
:where(.status>li>.tag){flex:none;min-width:5.4em;text-align:center}
:where(.dg){margin:0 0 14px}
:where(.dg>figcaption){font-weight:650;margin:0 0 10px}
:where(.dg>svg){display:block;width:100%;max-width:420px;height:auto}
:where(.dg-box){fill:#fff;stroke:rgb(23 19 43 / .22)}
:where(.dg-box.is-owner){fill:#FFF1E6;stroke:#FF9A4D}
:where(.dg-t){font-size:14px;font-weight:650;fill:#17132B}
:where(.dg-s){font-size:12px;fill:#4A4566}
:where(.dg-line){fill:none;stroke:#5F5983;stroke-width:1.5}
:where(.dg-head){fill:#5F5983}
:where(.dg-l){font-size:11.5px;fill:#5F5983;paint-order:stroke;stroke:#FBFAFE;stroke-width:4px;stroke-linejoin:round}
`.trim();

// 칸의 앞머리 스크립트. 작성자 스크립트보다 먼저 돌아 ResizeObserver·postMessage 를 바꿔치기 전에 잡아 둔다.
// - 높이: body 기준으로 잰다. documentElement.scrollHeight 는 칸 높이 아래로 내려가지 않아, 탭을 바꿔 글이 짧아져도 칸이 안 줄어든다.
// - 표: 가로 스크롤 상자로 감싼다. 표 자체를 display:block 으로 두면 칸 폭을 채우지 못한다.
// - 링크: 칸이 바깥 주소로 넘어가면(부모 CSP 가 막아) 빈 칸이 된다. 대신 부모에게 알려 대표가 열지 고르게 한다.
// - # 링크: 칸 안 이동은 그대로 둔다(전체 화면은 칸 안에서 움직인다). 맞춤 칸은 칸이 글 높이라 안에서 움직일 곳이 없어,
//   대상의 칸 안 위치를 {iamceoAnchor:y} 로 알려 부모가 바깥을 그만큼 굴린다. 대상이 없으면 보내지 않는다('#'·'#top' 은 맨 위).
// - Esc: 초점이 칸 안이면 전체 화면이 안 닫힌다.
// - WebRTC·preconnect: CSP 로 안 막히므로 생성자를 지우고, 나중에 들어온 중첩 칸·link 를 지운다(보조책, ARTIFACT_CSP 설명 참고).
//   관찰자가 못 보는 그림자 DOM 과, 조각내 칸을 숨겨 넣을 수 있는 document.write 도 함께 지운다.
// - document 의 것은 처음에 잡아 둔 원형으로 부른다. <img name="body"> 같은 이름 붙은 요소가 document.body 를 가려 높이를 잘못 잰다.
const HEIGHT_SCRIPT = `(function(){["RTCPeerConnection","webkitRTCPeerConnection"].forEach(function(k){try{delete window[k];window[k]=undefined}catch(e){}});var Q="iframe,frame,link",E=Element.prototype,Rm=E.remove,Mt=E.matches,Qa=E.querySelectorAll;function strip(n){if(n.nodeType!==1)return;if(Mt.call(n,Q))Rm.call(n);else Qa.call(n,Q).forEach(function(x){Rm.call(x)})}new MutationObserver(function(l){l.forEach(function(r){r.addedNodes.forEach(strip)})}).observe(document,{childList:true,subtree:true});[[E,"attachShadow"],[E,"setHTMLUnsafe"],[Document,"parseHTMLUnsafe"],[Document.prototype,"write"],[Document.prototype,"writeln"]].forEach(function(x){try{delete x[0][x[1]]}catch(e){}});var P=parent,O=ResizeObserver,last=-1,S=getComputedStyle,doc=document,DP=Document.prototype,G=function(n){return Object.getOwnPropertyDescriptor(DP,n).get},GB=G("body"),GR=G("documentElement"),DQ=DP.querySelectorAll,DC=DP.createElement,DI=DP.getElementById,DN=DP.getElementsByName;function B(){return GB.call(doc)}function R(){return GR.call(doc)}function send(){var b=B(),d=R(),n=0;if(b){var c=S(b);n=b.scrollHeight+(parseFloat(c.marginTop)||0)+(parseFloat(c.marginBottom)||0)}else if(d){n=d.scrollHeight}n=Math.ceil(n);if(n!==last){last=n;P.postMessage({iamceoHeight:n},"*")}}var r=new O(send);if(R())r.observe(R());send();addEventListener("DOMContentLoaded",function(){if(B())r.observe(B());DQ.call(doc,"table").forEach(function(t){if(t.parentElement&&t.parentElement.classList.contains("kit-table"))return;var w=DC.call(doc,"div");w.className="kit-table";t.parentNode.insertBefore(w,t);w.appendChild(t)});send()});addEventListener("load",send);addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#"){var id=h.slice(1),t=null,y=-1;try{id=decodeURIComponent(id)}catch(x){}if(id)t=DI.call(doc,id)||DN.call(doc,id)[0]||null;if(t&&t.getBoundingClientRect)y=t.getBoundingClientRect().top+scrollY;else if(!id||id.toLowerCase()==="top")y=0;if(y>=0)P.postMessage({iamceoAnchor:Math.max(0,Math.round(y))},"*");return}e.preventDefault();P.postMessage({iamceoLink:a.href},"*")},true);addEventListener("keydown",function(e){if(e.key==="Escape")P.postMessage({iamceoEscape:true},"*")},true)})()`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface ArtifactOpts {
  title?: string;
  lang?: string;
  /** false 면 스크립트 없는 칸(ARTIFACT_STATIC_SANDBOX)용: 높이 보고 스크립트를 넣지 않고 ARTIFACT_STATIC_CSP 를 쓴다. 기본 true. */
  scripts?: boolean;
}

/**
 * 격리 칸에 넣을 전체 문서. CSP 메타가 문서의 가장 앞에 오고 키트·높이 보고가 뒤따른 다음 작성자 글이 온다.
 * 앞머리는 고정 글이고 작성자 글은 언제나 그 뒤라, <!doctype>·<html>·<head>·주석·닫는 태그를 어떻게 써도 메타보다 앞서지 못한다.
 * 브라우저는 그 뒤의 doctype·html·head 시작 태그를 무시하므로 온전한 문서를 그대로 줘도 된다. 작성자가 넣은 CSP 는 더 조일 수만 있다.
 */
export function buildArtifactSrcdoc(html: string, opts: ArtifactOpts = {}): string {
  const lang = /^[A-Za-z-]{1,20}$/.test(opts.lang ?? "") ? opts.lang! : "ko";
  const scripts = opts.scripts !== false;
  const head = [
    `<!doctype html><html lang="${lang}"><head>`,
    `<meta http-equiv="Content-Security-Policy" content="${scripts ? ARTIFACT_CSP : ARTIFACT_STATIC_CSP}">`,
    `<meta http-equiv="x-dns-prefetch-control" content="off"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    opts.title ? `<title>${escapeHtml(opts.title)}</title>` : "",
    `<style>${ARTIFACT_KIT_CSS}</style>`,
    scripts ? `<script>${HEIGHT_SCRIPT}</script>` : "",
    `</head><body>`,
  ].join("");
  // 널 글자는 파서마다 다르게 다룬다. 작성자 글에 쓸 일이 없다.
  // 중첩 칸은 지운 RTCPeerConnection 이 살아 있는 새 realm 이고, link 는 파서가 넣는 즉시 preconnect 가 나간다. CSP 아래 둘 다 쓸모가 없으니 파서에 닿기 전에 이름을 바꾼다.
  const body = html.replaceAll("\0", "").replace(/<(\/?)(iframe|frameset|frame|link)(?=[\s/>])/gi, "<$1x-blocked-$2");
  return `${head}${body}</body></html>`;
}
