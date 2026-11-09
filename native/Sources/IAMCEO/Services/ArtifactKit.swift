import Foundation

/// The web board's artifact kit, for the native protected preview. Staff write artifacts against it (light page, 15/1.65
/// body, `.card` `.grid` `.kpi` `.callout` `.compare` `.steps` `.flow` `.tag` `.tabs` and table styles), so an artifact
/// shown without it falls back to WebKit defaults (white page, serif text, no cards).
///
/// `css` is `ARTIFACT_KIT_CSS` from shared/artifact-kit.ts, character for character (ArtifactKitTests compares them).
/// Every selector sits in `:where()`, so the author's own CSS always wins.
enum ArtifactKit {
    static let css = """
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
"""

    /// The protected preview's policy: inline styles and data: images/fonts only; no script, request, form or base.
    static let policy = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'\">"

    /// The whole document, as the web's buildArtifactSrcdoc lays it out minus its script (the native preview runs no
    /// page script): the policy first, then the kit, then the author's page. Whatever the author writes (doctype, html,
    /// head, comments) comes after the policy, so it can only tighten it. Nested frames and `<link>` are renamed before
    /// parsing (no preconnect), and NUL characters are dropped, as on the web.
    static func document(_ html: String, title: String? = nil) -> String {
        var head = "<!doctype html><html lang=\"ko\"><head>" + policy
        head += "<meta http-equiv=\"x-dns-prefetch-control\" content=\"off\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        if let title, !title.isEmpty { head += "<title>" + escape(title) + "</title>" }
        head += "<style>" + css + "</style></head><body>"
        var body = html.replacingOccurrences(of: "\u{0}", with: "")
        body = blocked.stringByReplacingMatches(in: body, range: NSRange(body.startIndex..., in: body), withTemplate: "<$1x-blocked-$2")
        return head + body + "</body></html>"
    }

    private static let blocked = try! NSRegularExpression(pattern: "<(/?)(iframe|frameset|frame|link)(?=[\\s/>])", options: [.caseInsensitive])

    private static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}
