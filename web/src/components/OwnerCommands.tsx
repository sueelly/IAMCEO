import { useEffect, useRef, useState } from "react";
import type { OwnerCommandItem } from "@shared/owner-commands";
import type { FileDoc, Message, ProjectState } from "@shared/types";
import { Glass } from "../glass";
import { api, errorText } from "../lib/api";
import { routeHash } from "../lib/store";
import { chooseTask } from "../lib/submission-client";
import { Markdown, Time } from "./ui";

const stages = { accepted: "접수", working: "진행 중", result: "결과", owner: "대표 응답", waiting: "대기" };

function Report({ projectId, reportId, title }: { projectId: string; reportId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<Message | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open || report) return;
    const request = new AbortController();
    setError("");
    api.message(reportId, request.signal).then(message => {
      if (request.signal.aborted) return;
      if (message.id !== reportId || message.projectId !== projectId) throw new Error("이 명령의 보고를 확인할 수 없습니다.");
      setReport(message);
    }).catch(e => { if (!request.signal.aborted) setError(errorText(e)); });
    return () => request.abort();
  }, [open, projectId, reportId, report]);
  return <div className="hm-report">
    <button type="button" className="hm-command-link" aria-expanded={open} onClick={() => setOpen(v => !v)}>{title}</button>
    {open && (error ? <p role="alert">{error}</p> : report ? <Markdown text={report.body || report.title} /> : <span role="status">보고를 불러오는 중</span>)}
  </div>;
}

function FileLinks({projectId, ids, files}: {projectId: string; ids: string[]; files: FileDoc[]}) {
  return ids.map((id, index) => <a key={id} className="hm-command-link" href={routeHash({projectId, tab:"files", sub:id})}>
    {files.find(file => file.id === id)?.title ?? (ids.length === 1 ? "자료 열기" : `자료 ${index+1} 열기`)}
  </a>);
}

function CommandRow({ item, files }: { item: OwnerCommandItem; files: FileDoc[] }) {
  const [expanded, setExpanded] = useState(false);
  const { projectId, result } = item;
  return <li className="hm-command" data-command-id={item.id}>
    <div className="hm-command__top">
      <span className="hm-command__stage" data-stage={item.stage}>{stages[item.stage]}</span>
      {item.kind === "task" && <span className="hm-command__legacy">기존 업무</span>}
      <Time iso={item.at} relative />
    </div>
    <button type="button" className="hm-command__title" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{item.title}</button>
    {item.detail && <p className="hm-command__detail">{item.detail}</p>}
    {item.questions.map(q => <a key={q.kind+q.id} className="hm-command-link" href={routeHash({ projectId, tab: q.kind === "todo" ? "home" : "inbox", sub: q.id })}>{q.title}</a>)}
    {result && <Report key={result.messageId} projectId={projectId} reportId={result.messageId} title={result.title || "결과 보고"} />}
    {result && <FileLinks projectId={projectId} files={files} ids={result.fileIds} />}
    {expanded && <div className="hm-command__more">
      {item.milestones?.map(step => <section key={step.kind+step.at+(step.messageId ?? "")} className="hm-milestone">
        <h3>{step.kind === "main" ? "원격 main 확인" : "담당자 적용 기록"}</h3>
        <p className="hm-command__detail">{step.actor} · <Time iso={step.at} /></p>
        <p>{step.evidence}</p>
        {step.commit && <code>{step.commit}</code>}
        {step.messageId && <Report key={step.messageId} projectId={projectId} reportId={step.messageId} title="근거 보고" />}
        <FileLinks projectId={projectId} files={files} ids={step.fileIds}/>
      </section>)}
      {item.kind === "command" && <Report key={item.id} projectId={projectId} reportId={item.id} title="명령 원문" />}
      {item.taskId && <a className="hm-command-link" href={routeHash({projectId,tab:"thread"})} onClick={() => chooseTask(projectId,{id:item.taskId!})}>업무 대화</a>}
    </div>}
  </li>;
}

export default function OwnerCommands({ state }: { state: ProjectState }) {
  const projectId = state.project.id;
  const [items, setItems] = useState<OwnerCommandItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [after, setAfter] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const request = new AbortController();
    let timer: number | undefined;
    let reading = false, pending = false;
    let lastStarted = 0;
    function schedule() {
      if (reading) { pending = true; return; }
      const delay = Math.max(0, lastStarted + 1200 - Date.now());
      timer ??= window.setTimeout(() => { timer = undefined; void read(); }, delay);
    }
    async function read() {
      reading = true;
      lastStarted = Date.now();
      setLoading(true);
      try {
        const page = await api.ownerCommands(projectId, after, request.signal);
        if (request.signal.aborted) return;
        setItems(page.items.filter(item => item.projectId === projectId));
        setCursor(page.nextCursor);
        setError("");
      } catch (e) { if (!request.signal.aborted) setError(errorText(e)); }
      finally {
        reading = false;
        if (!request.signal.aborted) {
          setLoading(false);
          if (pending) { pending = false; schedule(); }
        }
      }
    }
    refresh.current = schedule;
    schedule();
    return () => { clearTimeout(timer); request.abort(); };
  }, [projectId, after, retry]);
  useEffect(() => refresh.current(), [state.messages, state.tasks, state.decisions, state.todos, state.files, state.members, state.workflow]);
  const showPage = (next: string | null) => {
    setLoading(true);
    setItems([]);
    setCursor(null);
    setAfter(next);
  };
  return <Glass as="section" level="regular" tint className="hm-commands" aria-label="대표 명령">
    <header className="hm-commands__head"><h2>대표 명령</h2></header>
    {error && <div className="hm-error" role="alert">{error} <button type="button" onClick={()=>setRetry(v=>v+1)}>다시 불러오기</button></div>}
    <ul>{items.map(item=><CommandRow key={item.kind+":"+item.id} item={item} files={state.files}/>)}</ul>
    {!error && !items.length && <p className="hm-command__empty">{loading ? "명령을 불러오는 중" : "아직 지시한 업무가 없습니다."}</p>}
    {(after || cursor) && <div className="hm-command-pages">
      {after && <button type="button" className="hm-more-btn" onClick={() => showPage(null)}>최근 명령으로</button>}
      {cursor && <button type="button" className="hm-more-btn" disabled={loading} onClick={() => showPage(cursor)}>이전 명령·업무 보기</button>}
    </div>}
  </Glass>;
}
