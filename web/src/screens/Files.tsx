// 자료: 데스크톱은 목록+읽기 두 칸, 그보다 좁으면 목록→상세. 고른 자료는 주소(#/p/<id>/files/<fileId>)가 정한다.
// 입력칸에서 업무를 골랐으면 목록은 그 업무의 자료만 보인다(대화와 같은 업무 고르기, 대표 2026-11-16).
// 종류별 보기는 components/viewers, 아티팩트는 components/ArtifactFrame.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileDoc, FileKind, Task } from "@shared/types";
import type { AgentADocSummary, AgentAProjectInfo } from "@shared/agent-a";
import { Glass } from "../glass";
import { api, fileUrl } from "../lib/api";
import { AgentAReview } from "../components/AgentAReview";
import { routeHash, useProject, useRoute } from "../lib/store";
import { chooseTask, useSubmissionDraft } from "../lib/submission-client";
import { taskFiles } from "../lib/tasks";
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

// 프로젝트별 마지막 Agent-A 연결 정보. 자료 화면을 다시 열 때 첫 그림부터 Agent-A 문서 화면으로 띄운다.
const agentAInfoCache = new Map<string, AgentAProjectInfo>();
/** 첫 정보를 이만큼 기다려도 안 오면 일반 보기로 연다(연결이 느린 서버가 자료 화면을 막지 않게). */
const AGENT_A_FIRST_WAIT_MS = 3_000;

/**
 * Agent-A 연결 정보. 답을 기다리는 문서가 있으면 자주, 없으면 드물게 다시 읽는다. 탭을 숨기면 쉰다.
 * ready: 이 프로젝트의 정보를 한 번이라도 받았는지(또는 기다림이 끝났는지). 그 전에는 자료를 일반 보기로 그리지 않는다.
 * 그러지 않으면 Agent-A 문서가 잠깐 일반 보기(아티팩트면 '실행' 단추)로 보였다가 바뀐다.
 */
function useAgentA(projectId: string): { info: AgentAProjectInfo | null; ready: boolean } {
  const [state, setState] = useState<{ projectId: string; info: AgentAProjectInfo | null; ready: boolean }>(() => {
    const cached = agentAInfoCache.get(projectId) ?? null;
    return { projectId, info: cached, ready: !!cached };
  });
  // 프로젝트를 옮기면 앞 프로젝트의 정보를 쓰지 않는다(그리는 중에 맞춘다)
  if (state.projectId !== projectId) {
    const cached = agentAInfoCache.get(projectId) ?? null;
    setState({ projectId, info: cached, ready: !!cached });
  }
  const info = state.projectId === projectId ? state.info : null;
  const pending = info?.docs.some((d) => d.pending > 0) ?? false;
  useEffect(() => {
    const t = setTimeout(() => setState((s) => (s.projectId === projectId && !s.ready ? { ...s, ready: true } : s)), AGENT_A_FIRST_WAIT_MS);
    return () => clearTimeout(t);
  }, [projectId]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      if (document.visibilityState !== "hidden") {
        try {
          const next = await api.agentAInfo(projectId);
          agentAInfoCache.set(projectId, next);
          if (!stopped) setState({ projectId, info: next, ready: true });
        } catch {
          // 연결이 꺼진 서버·오류는 자료 화면을 막지 않는다
          if (!stopped) setState((s) => (s.projectId === projectId && !s.ready ? { ...s, ready: true } : s));
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
  return { info: info?.enabled ? info : null, ready: state.ready && state.projectId === projectId };
}

/** 다른 자료를 보는 동안 앞 자료의 댓글에 답이 오면 한 줄로 알린다. 누르면 그 자료를 열고, 댓글 칸의 '내 차례'에서 그 댓글로 간다. */
function AgentANotice({ info, files, projectId, selectedId }: { info: AgentAProjectInfo; files: FileDoc[]; projectId: string; selectedId: string | null }) {
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
  return (
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
}

/** 목록 위: 지금 거르는 업무. 맡은 직원은 적지 않는다(업무에는 여러 직원이 붙는다). */
function TaskNote({ task }: { task: Task }) {
  return (
    <div className="fl-task" role="note">
      <span className="fl-task__label">업무</span>
      <span className="fl-task__title">{task.title}</span>
    </div>
  );
}

/** otherTask: 이 자료의 업무가 지금 거르는 업무와 다를 때(전체 보기·링크로 연 자료)만 온다. 누르면 그 업무의 자료만 본다. */
function Reader({ file, agentA, ready = true, list, otherTask, onTask }: { file: FileDoc; agentA?: AgentAProjectInfo | null; ready?: boolean; list?: { open: boolean; toggle: () => void }; otherTask?: Task | null; onTask?: (task: Task) => void }) {
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
        {otherTask ? (
          <button type="button" className="fl-doc__task" title={`업무 ${otherTask.title}의 자료만 보기`} onClick={() => onTask?.(otherTask)}>
            <span className="fl-doc__task-text">{otherTask.title}</span>
          </button>
        ) : null}
      </p>
      <h2 className="fl-doc__title">{file.title}</h2>
      {file.summary ? <p className="fl-doc__summary">{file.summary}</p> : null}
      {/* 아티팩트는 그림이 주인공이다. 원본 경로는 다른 종류에서만 보여 준다. */}
      {file.path && file.kind !== "artifact" ? <PathLine path={file.path} /> : null}
      {linked && agentA ? (
        <AgentAReview fileId={file.id} title={file.title} info={agentA} />
      ) : ready ? (
        <FileViewer file={file} />
      ) : (
        <p className="fl-wait" role="status">
          자료를 여는 중…
        </p>
      )}
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
  const { info: agentA, ready: agentAReady } = useAgentA(projectId);
  // 입력칸에서 고른 업무(대화와 같은 초안). 목록에 없는 업무 id 면 '전체'로 본다.
  const { draft } = useSubmissionDraft(projectId);
  const tasks = project?.project.id === projectId ? project.tasks ?? [] : [];
  const task = draft.taskId ? tasks.find((t) => t.id === draft.taskId) ?? null : null;
  // Agent-A 문서를 볼 때 '자료 목록'으로 편 목록. 다른 자료를 고르면 다시 접어 본문을 넓게 본다(그리는 중에 맞춘다).
  const [listOpen, setListOpen] = useState(false);
  const [listFor, setListFor] = useState(sub);
  if (listFor !== sub) {
    setListFor(sub);
    setListOpen(false);
  }

  // 새 자료는 이벤트로 목록 끝에 붙으므로 서버와 같은 순서(최신 먼저)로 다시 맞춘다
  const all = useMemo(() => [...(project?.files ?? [])].sort((a, b) => b.order - a.order), [project?.files]);
  const files = useMemo(() => taskFiles(all, task?.id ?? null), [all, task?.id]);
  // 거르던 종류의 자료가 사라지면(다른 프로젝트로 옮김·다른 업무를 고름) 전체로 본다
  const activeKind = kind && files.some((f) => f.kind === kind) ? kind : null;
  const shown = useMemo(() => (activeKind ? files.filter((f) => f.kind === activeKind) : files), [files, activeKind]);
  // 링크로 온 자료는 거르기(종류·업무)와 상관없이 연다
  const selected = sub ? (all.find((f) => f.id === sub) ?? null) : desktop ? (shown[0] ?? null) : null;
  const otherTask = selected?.taskId && selected.taskId !== task?.id ? tasks.find((t) => t.id === selected.taskId) ?? null : null;
  const pickTask = (next: Task) => chooseTask(projectId, next);
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

  if (all.length === 0) {
    return (
      <div ref={rootRef}>
        <Empty title="아직 올린 자료가 없습니다">직원이 자료를 올리면 여기에 모입니다.</Empty>
      </div>
    );
  }

  // 고른 업무에 자료가 없고 링크로 연 자료도 없으면 빈 두 칸 대신 안내만 보인다
  if (task && files.length === 0 && sub === null) {
    return (
      <div ref={rootRef} className="fl">
        <TaskNote task={task} />
        <Empty title="이 업무에 올린 자료가 없습니다">모든 자료는 입력칸 위 ‘전체’에서 봅니다.</Empty>
        {agentA ? <AgentANotice info={agentA} files={all} projectId={projectId} selectedId={null} /> : null}
      </div>
    );
  }

  const list = (
    <Glass level="regular" tint className="fl-panel fl-panel--list">
      <div className="fl-listbox">
        {task ? <TaskNote task={task} /> : null}
        <KindChips files={files} kind={activeKind} onPick={setKind} />
        {shown.length > 0 ? (
          <ul className="fl-list" aria-label={task ? `자료 목록: 업무 ${task.title}` : "자료 목록"}>
            {shown.map((f) => (
              <FileRow key={f.id} file={f} projectId={projectId} current={f.id === selected?.id} agentA={agentA?.docs.find((d) => d.fileId === f.id)} />
            ))}
          </ul>
        ) : (
          <p className="fl-none">이 업무에 올린 자료가 없습니다.</p>
        )}
      </div>
    </Glass>
  );

  if (desktop) {
    // Agent-A 문서는 본문 옆에 댓글 칸이 펴져 폭이 넉넉해야 한다. 그래서 목록을 접고 읽기 판을 넓힌다. '자료 목록'으로 다시 편다.
    const focus = linkedSelected && !listOpen;
    return (
      <div ref={rootRef} className="fl fl--desk" data-wide={selected?.kind === "artifact" || linkedSelected ? "" : undefined} data-focus={focus ? "" : undefined}>
        {list}
        <Glass level="regular" tint className="fl-panel fl-panel--reader">
          <div ref={readerRef} className="fl-reader">
            {selected ? <Reader key={selected.id} file={selected} agentA={agentA} ready={agentAReady} list={linkedSelected ? { open: listOpen, toggle: () => setListOpen((v) => !v) } : undefined} otherTask={otherTask} onTask={pickTask} /> : <Missing />}
          </div>
        </Glass>
        {agentA ? <AgentANotice info={agentA} files={all} projectId={projectId} selectedId={selected?.id ?? null} /> : null}
      </div>
    );
  }

  if (sub === null) {
    return (
      <div ref={rootRef} className="fl">
        {list}
        {agentA ? <AgentANotice info={agentA} files={all} projectId={projectId} selectedId={null} /> : null}
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
        {selected ? <Reader key={selected.id} file={selected} agentA={agentA} ready={agentAReady} otherTask={otherTask} onTask={pickTask} /> : <Missing />}
      </Glass>
      {agentA ? <AgentANotice info={agentA} files={all} projectId={projectId} selectedId={selected?.id ?? null} /> : null}
    </div>
  );
}
