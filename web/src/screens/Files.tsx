// 자료: 데스크톱은 목록+읽기 두 칸, 그보다 좁으면 목록→상세. 고른 자료는 주소(#/p/<id>/files/<fileId>)가 정한다.
// 입력칸에서 업무를 골랐으면 목록은 그 업무의 자료만 보인다(대화와 같은 업무 고르기, 대표 2026-11-16).
// 종류별 보기는 components/viewers, 아티팩트는 components/ArtifactFrame.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileDoc, FileKind, FileListItem, Task } from "@shared/types";
import { Glass } from "../glass";
import { fileUrl } from "../lib/api";
import { routeHash, useProject, useRoute, useStore } from "../lib/store";
import { chooseTask, useSubmissionDraft } from "../lib/submission-client";
import { taskFiles } from "../lib/tasks";
import { useFileDetail, useFilePages } from "../lib/files";
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
function Reader({ file, otherTask, onTask }: { file: FileDoc; otherTask?: Task | null; onTask?: (task: Task) => void }) {
  return (
    <article className="fl-doc" data-kind={file.kind}>
      <p className="fl-doc__meta">
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
      <FileViewer file={file} />
    </article>
  );
}

function FileRow({ file, projectId, current }: { file: FileListItem; projectId: string; current: boolean }) {
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

function KindChips({ counts, kind, onPick }: { counts: Partial<Record<FileKind, number>>; kind: FileKind | null; onPick: (k: FileKind | null) => void }) {
  const present = KIND_ORDER.filter((k) => (counts[k] ?? 0) > 0);
  // 한 종류뿐이면 거를 것이 없다
  if (present.length < 2 && (!kind || present.includes(kind))) return null;
  const chip = (k: FileKind | null, label: string, n: number) => (
    <button key={k ?? "all"} type="button" className="fl-chip" aria-pressed={kind === k} onClick={() => onPick(k)}>
      {label} <span className="t-tabular">{n}</span>
    </button>
  );
  return (
    <div className="fl-chips" role="group" aria-label="종류로 거르기">
      {chip(null, "전체", Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0))}
      {present.map((k) => chip(k, KIND_LABEL[k], counts[k]!))}
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
  const [kindSelection, setKindSelection] = useState<{ scope: string; kind: FileKind | null }>({ scope: "", kind: null });
  const paged = useStore(s => s.capabilities?.capabilities.compactState === true);
  const listRef = useRef<HTMLUListElement>(null);
  const sentinel = useRef<HTMLLIElement>(null);
  const projectId = route.projectId;
  const sub = route.sub;
  // 입력칸에서 고른 업무(대화와 같은 초안). 목록에 없는 업무 id 면 '전체'로 본다.
  const { draft } = useSubmissionDraft(projectId);
  const tasks = project?.project.id === projectId ? project.tasks ?? [] : [];
  const task = draft.taskId ? tasks.find((t) => t.id === draft.taskId) ?? null : null;

  const scope = JSON.stringify([projectId, task?.id ?? null]);
  const activeKind = kindSelection.scope === scope ? kindSelection.kind : null;
  const setKind = (kind: FileKind | null) => setKindSelection({ scope, kind });
  const feed = useFilePages(projectId, task?.id ?? null, activeKind, paged, project?.files ?? []);
  const all = useMemo(() => [...(project?.files ?? [])].sort((a, b) => b.order - a.order), [project?.files]);
  const files = useMemo(() => taskFiles(all, task?.id ?? null), [all, task?.id]);
  const shown = paged ? feed.items : activeKind ? files.filter(f => f.kind === activeKind) : files;
  const counts = paged ? feed.counts : files.reduce<Partial<Record<FileKind, number>>>((counts, f) => { counts[f.kind] = (counts[f.kind] ?? 0) + 1; return counts; }, {});
  const selectedId = sub ?? (desktop ? shown[0]?.id ?? null : null);
  const detail = useFileDetail(projectId, selectedId, paged);
  const metadata = project?.files.find(f => f.id === selectedId) ?? feed.items.find(f => f.id === selectedId);
  const selected = paged ? detail.file ? { ...detail.file, ...metadata, body: detail.file.body } : null : all.find(f => f.id === selectedId) ?? null;
  const otherTask = selected?.taskId && selected.taskId !== task?.id ? tasks.find((t) => t.id === selected.taskId) ?? null : null;
  const pickTask = (next: Task) => chooseTask(projectId, next);
  const reader = selected ? <Reader key={selected.id} file={selected} otherTask={otherTask} onTask={pickTask} />
    : detail.error ? <div className="fl-none" role="alert">{detail.error} <button onClick={detail.retry}>다시 불러오기</button></div>
    : selectedId ? <p className="fl-none" role="status">불러오는 중…</p> : <Missing />;
  const loading = paged && feed.loading;
  useEffect(() => {
    if (!paged || !feed.hasMore || feed.loading || feed.error || !sentinel.current || typeof IntersectionObserver === "undefined") return;
    const root = desktop ? listRef.current : rootRef.current?.closest<HTMLElement>("[data-scroll-root]");
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void feed.loadMore();
    }, { root, rootMargin: "240px" });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [paged, feed.hasMore, feed.loading, feed.error, feed.loadMore, desktop]);

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

  if (paged && shown.length === 0 && !sub && (loading || feed.error)) {
    return <div ref={rootRef} className="fl"><p className="fl-none" role={feed.error ? "alert" : "status"}>{feed.error ?? "불러오는 중…"}</p>{feed.error ? <button onClick={() => void feed.loadMore()}>다시 불러오기</button> : null}</div>;
  }

  if ((paged ? Object.values(counts).reduce((n, value) => n + (value ?? 0), 0) === 0 : all.length === 0) && !sub && !task) {
    return (
      <div ref={rootRef}>
        <Empty title="아직 올린 자료가 없습니다">직원이 자료를 올리면 여기에 모입니다.</Empty>
      </div>
    );
  }

  // 고른 업무에 자료가 없고 링크로 연 자료도 없으면 빈 두 칸 대신 안내만 보인다
  if (task && (paged ? Object.values(counts).every(n => !n) : files.length === 0) && !loading && sub === null) {
    return (
      <div ref={rootRef} className="fl">
        <TaskNote task={task} />
        <Empty title="이 업무에 올린 자료가 없습니다">모든 자료는 입력칸 위 ‘전체’에서 봅니다.</Empty>
      </div>
    );
  }

  const list = (
    <Glass level="regular" tint className="fl-panel fl-panel--list">
      <div className="fl-listbox">
        {task ? <TaskNote task={task} /> : null}
        <KindChips counts={counts} kind={activeKind} onPick={setKind} />
        {shown.length > 0 ? (
          <ul ref={listRef} className="fl-list" aria-label={task ? `자료 목록: 업무 ${task.title}` : "자료 목록"}>
            {shown.map((f) => (
              <FileRow key={f.id} file={f} projectId={projectId} current={f.id === selectedId} />
            ))}
            {paged && (feed.hasMore || feed.loading || feed.error) ? <li ref={sentinel} className="fl-more">
              {feed.loading ? <span role="status">불러오는 중…</span> : <>
                {feed.error ? <span role="alert">{feed.error} </span> : null}
                <button type="button" onClick={() => void feed.loadMore()}>{feed.error ? "다시 불러오기" : "더 불러오기"}</button>
              </>}
            </li> : null}
          </ul>
        ) : (
          <p className="fl-none">이 업무에 올린 자료가 없습니다.</p>
        )}
      </div>
    </Glass>
  );

  if (desktop) {
    return (
      <div ref={rootRef} className="fl fl--desk" data-wide={selected?.kind === "artifact" ? "" : undefined}>
        {list}
        <Glass level="regular" tint className="fl-panel fl-panel--reader">
          <div ref={readerRef} className="fl-reader">
            {reader}
          </div>
        </Glass>
      </div>
    );
  }

  if (sub === null) {
    return (
      <div ref={rootRef} className="fl">
        {list}
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
        {reader}
      </Glass>
    </div>
  );
}
