// Agent-A 원래 화면(문서·드래그 선택 댓글·대댓글·전체 댓글·그림 영역·수정안·판)을 자료 칸에 그대로 띄운다.
// 열쇠는 브라우저에 넘기지 않는다: Agent-A 가 '이 기기에서만 받는' 기본 방식일 때만 서버가 주소를 준다.
// 전체 화면은 아티팩트 칸과 같은 방식(<dialog> showModal)이다. 칸을 옮기지 않으므로 원래 화면이 다시 읽히지 않는다.
import { useEffect, useRef, useState } from "react";
import type { AgentAProjectInfo } from "@shared/agent-a";
import { api } from "../lib/api";
import "../styles/agent-a.css";

export function AgentAFrame({ fileId, title, info }: { fileId: string; title: string; info: AgentAProjectInfo }) {
  const doc = info.docs.find((d) => d.fileId === fileId);
  const unseen = doc?.unseen ?? 0;
  const hostRef = useRef<HTMLDialogElement>(null);
  const [full, setFull] = useState(false);
  // 이 자료를 열어 두었으면 알린 답을 읽은 것으로 둔다(목록의 '새 답'이 사라진다).
  useEffect(() => {
    void api.agentARead(fileId).catch(() => {});
  }, [fileId, unseen]);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClose = () => setFull(false);
    host.addEventListener("close", onClose);
    return () => host.removeEventListener("close", onClose);
  }, [doc, info.uiUrl]);
  if (!doc) return null;
  if (!info.uiUrl) return <p className="aa-warn" role="status">{info.uiBlocked ?? "Agent-A 원래 화면을 열 수 없습니다"}</p>;
  const src = `${info.uiUrl}/?artifact=${encodeURIComponent(doc.artifactId)}`;
  const toggle = () => {
    const host = hostRef.current;
    if (!host) return;
    if (host.open) host.close();
    else {
      host.showModal();
      setFull(true);
    }
  };
  return (
    <dialog ref={hostRef} className="afr aa-frame" role={full ? undefined : "group"} aria-label={full ? title : "Agent-A 문서"}>
      <div className="afr-bar">
        <span className="afr-bar__title">{full ? title : "Agent-A 원래 화면"}</span>
        <span className="vw-bar__actions">
          <a className="vw-btn" href={src} target="_blank" rel="noopener noreferrer">
            새 창
          </a>
          <button type="button" className="vw-btn" onClick={toggle}>
            {full ? "닫기" : "전체 화면"}
          </button>
        </span>
      </div>
      <iframe className="aa-frame__view" title={`Agent-A · ${title}`} src={src} allow="clipboard-read; clipboard-write; microphone" />
    </dialog>
  );
}
