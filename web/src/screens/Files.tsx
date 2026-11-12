// 자료: 데스크톱은 목록+읽기 두 칸, 그보다 좁으면 목록→상세. 고른 자료는 주소(#/p/<id>/files/<fileId>)가 정한다.
// 종류별 보기는 components/viewers, 아티팩트는 components/ArtifactFrame.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FileDoc, FileKind } from "@shared/types";
import type { AgentADocSummary, AgentAProjectInfo } from "@shared/agent-a";
import { Glass } from "../glass";
import { api, fileUrl } from "../lib/api";
import { AgentAFrame } from "../components/AgentAFrame";
import { routeHash, useProject, useRoute } from "../lib/store";
import { Empty, MQ_DESKTOP, Time, copyText, useMediaQuery } from "../components/ui";
import { FileViewer, KIND_LABEL, KIND_ORDER } from "../components/viewers";
import "../styles/files.css";

const COPIED_MS = 2000;

function PathLine({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(path))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <div className="fl-path">
      <code className="fl-path__text t-code">{path}</code>
      <button type="button" className="fl-path__copy" aria-label="원본 경로 복사" onClick={() => void copy()}>
        {copied ? "복사됨" : "복사"}
      </button>
    </div>
  );
}

/** Agent-A 연결 정보. 답을 기다리는 문서가 있으면 자주, 없으면 드물게 다시 읽는다. 탭을 숨기면 쉰다. */
function useAgentA(projectId: string): AgentAProjectInfo | null {
  const [info, setInfo] = useState<AgentAProjectInfo | null>(null);
  const pending = info?.docs.some((d) => d.pending > 0) ?? false;
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      if (document.visibilityState !== "hidden") {
        try {
          const next = await api.agentAInfo(projectId);
          if (!stopped) setInfo(next);
        } catch {
          // 연결이 꺼진 서버·오류는 자료 화면을 막지 않는다
        }
      }
      if (!stopped) timer = setTimeout(run, pending ? 4_000 : 8_000);
    };
    void run();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [projectId, pending]);
  return info?.enabled ? info : null;
}

/** 다른 자료를 보는 동안 앞 자료의 댓글에 답이 오면 한 줄로 알린다. 누르면 그 자료를 열고, 원래 화면의 '내 차례'에서 그 댓글로 간다. */
function AgentANotice({ info, files, projectId, selectedId, host }: { info: AgentAProjectInfo; files: FileDoc[]; projectId: string; selectedId: string | null; host?: HTMLElement | null }) {
  const seen = useRef<Map<string, number> | null>(null);
  const [notice, setNotice] = useState<{ doc: AgentADocSummary; title: string } | null>(null);
  useEffect(() => {
    const prev = seen.current;
    const next = new Map(info.docs.map((d) => [d.fileId, d.unseen]));
    seen.current = next;
    if (!prev) return;
    const grown = info.docs.find((d) => d.unseen > (prev.get(d.fileId) ?? 0) && d.fileId !== selectedId);
    if (grown) setNotice({ doc: grown, title: files.find((f) => f.id === grown.fileId)?.title ?? "자료" });
  }, [info, files, selectedId]);
  if (!notice) return null;
  // 전체 화면(최상위 층의 <dialog>) 안에서는 그 안에 띄운다. 밖에 두면 전체 화면 뒤에 가려진다.
  const box = (
    <div className="aa-notice" role="status">
      <span>'{notice.title}' 댓글에 답이 왔습니다</span>
      <a className="aa-btn" href={routeHash({ projectId, tab: "files", sub: notice.doc.fileId })} onClick={() => setNotice(null)}>
        자료 열기
      </a>
      <button type="button" className="aa-link" onClick={() => setNotice(null)}>
        닫기
      </button>
    </div>
  );
  return host ? createPortal(box, host) : box;
}

function Reader({ file, agentA, onFull, list }: { file: FileDoc; agentA?: AgentAProjectInfo | null; onFull?: (host: HTMLDialogElement | null) => void; list?: { open: boolean; toggle: () => void } }) {
  const linked = agentA?.docs.some((d) => d.fileId === file.id) ?? false;
  return (
    <article className="fl-doc" data-kind={file.kind} data-agent-a={linked ? "" : undefined}>
      <p className="fl-doc__meta">
        {list ? (
          <button type="button" className="fl-listtoggle" aria-expanded={list.open} onClick={list.toggle}>
            {list.open ? "목록 접기" : "자료 목록"}
          </button>
        ) : null}
        <span className="fl-kind" data-kind={file.kind}>
          {KIND_LABEL[file.kind]}
        </span>
        {file.who ? <span className="fl-doc__who">{file.who}</span> : null}
        <Time iso={file.createdAt} />
      </p>
      <h2 className="fl-doc__title">{file.title}</h2>
      {file.summary ? <p className="fl-doc__summary">{file.summary}</p> : null}
      {/* 아티팩트는 그림이 주인공이다. 원본 경로는 다른 종류에서만 보여 준다. */}
      {file.path && file.kind !== "artifact" ? <PathLine path={file.path} /> : null}
      {linked && agentA ? <AgentAFrame fileId={file.id} title={file.title} info={agentA} onFull={onFull} /> : <FileViewer file={file} />}
    </article>
  );
}

function FileRow({ file, projectId, current, agentA }: { file: FileDoc; projectId: string; current: boolean; agentA?: AgentADocSummary }) {
  const thumb = file.attachments.find((a) => a.isImage);
  return (
    <li>
      <a className="fl-row" href={routeHash({ projectId, tab: "files", sub: file.id })} aria-current={current ? "page" : undefined}>
        <span className="fl-row__main">
          <span className="fl-row__title">{file.title}</span>
          {file.summary ? <span className="fl-row__summary">{file.summary}</span> : null}
          <span className="fl-row__meta">
            <span className="fl-kind" data-kind={file.kind}>
              {KIND_LABEL[file.kind]}
            </span>
            {agentA ? <span className="aa-tag">Agent-A</span> : null}
            {agentA?.pending ? <span className="aa-chip" data-state="running">답 기다림 {agentA.pending}</span> : null}
            {agentA?.unseen ? <span className="aa-chip" data-state="answered">새 답 {agentA.unseen}</span> : null}
            <span>
              {file.who ? `${file.who} · ` : ""}
              <Time iso={file.createdAt} />
            </span>
          </span>
        </span>
        {thumb ? <img className="fl-row__thumb" src={fileUrl(thumb)} alt="" loading="lazy" /> : null}
      </a>
    </li>
  );
}

function KindChips({ files, kind, onPick }: { files: FileDoc[]; kind: FileKind | null; onPick: (k: FileKind | null) => void }) {
  const counts = new Map<FileKind, number>();
  for (const f of files) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const present = KIND_ORDER.filter((k) => counts.has(k));
  // 한 종류뿐이면 거를 것이 없다
  if (present.length < 2) return null;
  const chip = (k: FileKind | null, label: string, n: number) => (
    <button key={k ?? "all"} type="button" className="fl-chip" aria-pressed={kind === k} onClick={() => onPick(k)}>
      {label} <span className="t-tabular">{n}</span>
    </button>
  );
  return (
    <div className="fl-chips" role="group" aria-label="종류로 거르기">
      {chip(null, "전체", files.length)}
      {present.map((k) => chip(k, KIND_LABEL[k], counts.get(k)!))}
    </div>
  );
}

function Missing() {
  return <Empty title="찾을 수 없는 자료입니다">목록에서 다시 골라 주세요.</Empty>;
}

export default function Files() {
  const project = useProject();
  const route = useRoute();
  const desktop = useMediaQuery(MQ_DESKTOP);
  const rootRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const [kind, setKind] = useState<FileKind | null>(null);
  const projectId = route.projectId;
  const sub = route.sub;
  const agentA = useAgentA(projectId);
  // Agent-A 전체 화면 칸. 열려 있으면 답 알림을 그 안에 띄운다.
  const [fullHost, setFullHost] = useState<HTMLDialogElement | null>(null);
  const [listOpen, setListOpen] = useState(false);

  // 새 자료는 이벤트로 목록 끝에 붙으므로 서버와 같은 순서(최신 먼저)로 다시 맞춘다
  const files = useMemo(() => [...(project?.files ?? [])].sort((a, b) => b.order - a.order), [project?.files]);
  // 거르던 종류의 자료가 사라지면(다른 프로젝트로 옮김) 전체로 본다
  const activeKind = kind && files.some((f) => f.kind === kind) ? kind : null;
  const shown = useMemo(() => (activeKind ? files.filter((f) => f.kind === activeKind) : files), [files, activeKind]);
  // 링크로 온 자료는 거르기와 상관없이 연다
  const selected = sub ? (files.find((f) => f.id === sub) ?? null) : desktop ? (shown[0] ?? null) : null;
  const linkedSelected = Boolean(selected && agentA?.docs.some((d) => d.fileId === selected.id));

  // 다른 자료를 열면 처음부터 읽는다. 폰에서 목록으로 돌아오면 보던 자리로.
  const prevSub = useRef(sub);
  useLayoutEffect(() => {
    const root = rootRef.current?.closest<HTMLElement>("[data-scroll-root]");
    if (root && !desktop && sub !== prevSub.current) {
      if (prevSub.current === null) listScroll.current = root.scrollTop;
      root.scrollTop = sub === null ? listScroll.current : 0;
    }
    readerRef.current?.scrollTo(0, 0);
    prevSub.current = sub;
  }, [sub, desktop]);

  if (files.length === 0) {
    return (
      <div ref={rootRef}>
        <Empty title="아직 올린 자료가 없습니다">직원이 자료를 올리면 여기에 모입니다.</Empty>
      </div>
    );
  }

  const list = (
    <Glass level="regular" tint className="fl-panel fl-panel--list">
      <div className="fl-listbox">
        <KindChips files={files} kind={activeKind} onPick={setKind} />
        <ul className="fl-list" aria-label="자료 목록">
          {shown.map((f) => (
            <FileRow key={f.id} file={f} projectId={projectId} current={f.id === selected?.id} agentA={agentA?.docs.find((d) => d.fileId === f.id)} />
          ))}
        </ul>
      </div>
    </Glass>
  );

  if (desktop) {
    // Agent-A 문서는 댓글 칸까지 펴지려면 폭이 넉넉해야 한다(약 1000px). 그래서 목록을 접고 읽기 판을 넓힌다. '자료 목록'으로 다시 편다.
    const focus = linkedSelected && !listOpen;
    return (
      <div ref={rootRef} className="fl fl--desk" data-wide={selected?.kind === "artifact" || linkedSelected ? "" : undefined} data-focus={focus ? "" : undefined}>
        {list}
        <Glass level="regular" tint className="fl-panel fl-panel--reader">
          <div ref={readerRef} className="fl-reader">
            {selected ? <Reader key={selected.id} file={selected} agentA={agentA} onFull={setFullHost} list={linkedSelected ? { open: listOpen, toggle: () => setListOpen((v) => !v) } : undefined} /> : <Missing />}
          </div>
        </Glass>
        {agentA ? <AgentANotice info={agentA} files={files} projectId={projectId} selectedId={selected?.id ?? null} host={fullHost} /> : null}
      </div>
    );
  }

  if (sub === null) {
    return (
      <div ref={rootRef} className="fl">
        {list}
        {agentA ? <AgentANotice info={agentA} files={files} projectId={projectId} selectedId={null} /> : null}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="fl">
      <a className="fl-back" href={routeHash({ projectId, tab: "files" })}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        자료
      </a>
      <Glass level="regular" tint className="fl-panel fl-panel--phone">
        {selected ? <Reader key={selected.id} file={selected} agentA={agentA} onFull={setFullHost} /> : <Missing />}
      </Glass>
      {agentA ? <AgentANotice info={agentA} files={files} projectId={projectId} selectedId={selected?.id ?? null} host={fullHost} /> : null}
    </div>
  );
}
