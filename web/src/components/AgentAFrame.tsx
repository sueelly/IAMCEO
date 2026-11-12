// Agent-A 원래 기능(문장 드래그 댓글·대댓글·전체 댓글·그림 영역·수정안·Save·판)을 자료 칸에서 바로 쓴다.
// 화면은 IAMCEO 주소 아래 입장권 경로(/agent-a-ui/s/...)로 열린다: 이 Mac·Tailscale·폰 어디서 IAMCEO 를 열든 같다.
// Agent-A 주소·열쇠는 브라우저에 오지 않는다. 칸은 격리(sandbox, allow-same-origin 없음)라 문서 내용이 IAMCEO 접속 코드에 닿지 못한다.
// 전체 화면은 아티팩트 칸과 같은 방식(<dialog> showModal)이다. 칸을 옮기지 않으므로 화면이 다시 읽히지 않는다.
import { useEffect, useRef, useState } from "react";
import type { AgentAProjectInfo } from "@shared/agent-a";
import { api, errorText } from "../lib/api";
import "../styles/agent-a.css";

// 입장권은 서버 메모리에 8시간 산다. 한 시간 남기 전에 새로 받는다(자료를 옮겨 다닐 때마다 받지 않는다).
let cached: { base: string; until: number } | null = null;
async function uiBase(force = false): Promise<string> {
  if (!force && cached && cached.until > Date.now()) return cached.base;
  const s = await api.agentAUiSession();
  cached = { base: s.base, until: Date.parse(s.expiresAt) - 60 * 60 * 1000 };
  return s.base;
}

export function AgentAFrame({ fileId, title, info, onFull }: { fileId: string; title: string; info: AgentAProjectInfo; onFull?: (host: HTMLDialogElement | null) => void }) {
  const doc = info.docs.find((d) => d.fileId === fileId);
  const unseen = doc?.unseen ?? 0;
  const hostRef = useRef<HTMLDialogElement>(null);
  const [full, setFull] = useState(false);
  const [base, setBase] = useState<string | null>(cached && cached.until > Date.now() ? cached.base : null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // 이 자료를 열어 두었으면 알린 답을 읽은 것으로 둔다(목록의 '새 답'이 사라진다).
  useEffect(() => {
    void api.agentARead(fileId).catch(() => {});
  }, [fileId, unseen]);
  useEffect(() => {
    if (!info.ui) return;
    let stop = false;
    uiBase()
      .then((b) => !stop && setBase(b))
      .catch((e) => !stop && setError(errorText(e)));
    return () => {
      stop = true;
    };
  }, [info.ui]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClose = () => {
      setFull(false);
      onFull?.(null);
    };
    host.addEventListener("close", onClose);
    return () => host.removeEventListener("close", onClose);
  }, [doc, base, onFull]);
  useEffect(() => () => onFull?.(null), [onFull]);
  if (!doc) return null;
  if (!info.ui) return <p className="aa-warn" role="status">{info.uiBlocked ?? "Agent-A 화면을 열 수 없습니다"}</p>;
  if (error) {
    return (
      <p className="aa-warn" role="status">
        Agent-A 화면을 열지 못했습니다: {error}{" "}
        <button type="button" className="aa-link" onClick={() => { setError(null); void uiBase(true).then(setBase, (e) => setError(errorText(e))); }}>
          다시 열기
        </button>
      </p>
    );
  }
  const src = base ? `${base}/?artifact=${encodeURIComponent(doc.artifactId)}` : null;
  const toggle = () => {
    const host = hostRef.current;
    if (!host) return;
    if (host.open) host.close();
    else {
      host.showModal();
      setFull(true);
      onFull?.(host);
    }
  };
  return (
    <dialog ref={hostRef} className="afr aa-frame" role={full ? undefined : "group"} aria-label={full ? title : "Agent-A 문서"}>
      <div className="afr-bar">
        {full ? <span className="afr-bar__title">{title}</span> : null}
        <button type="button" className="vw-btn" onClick={toggle}>
          {full ? "닫기" : "전체 화면"}
        </button>
      </div>
      <div className="aa-frame__stage">
        {src ? (
          <iframe
            key={src}
            className="aa-frame__view"
            title={`Agent-A · ${title}`}
            src={src}
            sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            allow="clipboard-write"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
          />
        ) : null}
        {!loaded ? <p className="afr-loading">문서를 여는 중…</p> : null}
      </div>
    </dialog>
  );
}
