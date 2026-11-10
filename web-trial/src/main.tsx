// 업무 중심 로컬 체험판 웹. 업무가 대화·결재·자료·실행의 주인이고, 결재는 전체 '내 차례'에 모인다.
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { HindsightConfig, HindsightRecordView, TaskDetail, TaskStatus, WorkDecision, WorkFile, WorkMessage, WorkState, WorkTask } from "../../shared/work-types.ts";
import "../../web/src/styles/tokens.css";
import "./trial.css";

// ---- 접속 코드·API ----
const CODE_KEY = "iamceo.trial.code";
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 이번 화면은 쓴다 */ } },
};
let memoryCode: string | null = null;
function takeCodeFromHash() {
  const m = location.hash.match(/code=([A-Za-z0-9_-]+)/);
  if (m) { memoryCode = m[1]!; store.set(CODE_KEY, m[1]!); history.replaceState(null, "", location.pathname + "#/all"); }
}
takeCodeFromHash();
const code = () => memoryCode ?? store.get(CODE_KEY);

class HttpError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }
async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, cache: "no-store", headers: { Authorization: `Bearer ${code() ?? ""}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new HttpError(0, "서버에 연결할 수 없습니다"); }
  if (!res.ok) { let msg = `요청 실패 (${res.status})`; try { msg = (await res.json()).error ?? msg; } catch { /* */ } throw new HttpError(res.status, msg); }
  return (await res.json()) as T;
}
function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- 라우트 ----
type Route = { view: "all" | "inbox" | "files" | "roles" | "hindsight" } | { view: "project"; id: string } | { view: "goal"; id: string } | { view: "task"; id: string };
function parseRoute(): Route {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const [v, id] = parts;
  if ((v === "project" || v === "goal" || v === "task") && id) return { view: v, id: decodeURIComponent(id) };
  if (v === "inbox" || v === "files" || v === "roles" || v === "hindsight") return { view: v };
  return { view: "all" };
}
function useRoute(): Route {
  const [r, setR] = useState(parseRoute);
  useEffect(() => { const on = () => setR(parseRoute()); addEventListener("hashchange", on); return () => removeEventListener("hashchange", on); }, []);
  return r;
}
const href = (r: Route) => (r.view === "project" || r.view === "goal" || r.view === "task" ? `#/${r.view}/${encodeURIComponent(r.id)}` : `#/${r.view}`);

// ---- 표시 ----
const STATUS: Record<TaskStatus, string> = { received: "접수", working: "진행 중", waiting_owner: "대표 답 대기", waiting_dep: "선행 결과 대기", done: "완료" };
const SOURCE: Record<string, string> = { owner: "대표 지시", handoff: "인계", answer: "결재 답", dependency: "선행 결과", collab_question: "협업 질문", collab_answer: "협업 답" };
const REASON: Record<string, string> = { start: "시작", role_change: "역할 변경", model_change: "모델 변경", resume: "재개" };
const HS: Record<string, string> = { not_configured: "연결 전", uploaded: "올라감", failed: "실패", unknown: "응답 유실·미확인" };
const time = (iso: string) => new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Badge({ tone = "plain", children }: { tone?: "plain" | "ok" | "warn" | "danger" | "accent"; children: ReactNode }) {
  return <span className={`b b--${tone}`}>{children}</span>;
}
function StatusBadge({ s }: { s: TaskStatus }) {
  const tone = s === "done" ? "ok" : s === "waiting_owner" ? "warn" : s === "waiting_dep" ? "plain" : "accent";
  return <Badge tone={tone}>{STATUS[s]}</Badge>;
}
function Md({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---- 상태 불러오기 ----
function usePoll<T>(load: (() => Promise<T>) | null, ms: number, key: string): { data: T | null; error: HttpError | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<HttpError | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { setData(null); }, [key]);
  useEffect(() => {
    if (!load) return;
    let live = true;
    const run = () => load().then((d) => { if (live) { setData(d); setError(null); } }, (e) => { if (live) setError(e instanceof HttpError ? e : new HttpError(0, String(e))); });
    run();
    const t = setInterval(() => { if (document.visibilityState === "visible") run(); }, ms);
    return () => { live = false; clearInterval(t); };
  }, [key, tick]);
  return { data, error, reload: useCallback(() => setTick((x) => x + 1), []) };
}

// ---- 앱 ----
function App() {
  const route = useRoute();
  const [authTick, setAuthTick] = useState(0);
  const { data: state, error, reload } = usePoll(() => api<WorkState>("GET", "/api/state"), 1500, `state-${authTick}`);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [route]);
  if (error?.status === 401 || (!code() && !state)) return <Login onDone={() => setAuthTick((x) => x + 1)} />;
  if (!state) return <div className="boot">{error ? error.message : "불러오는 중"}</div>;
  const inbox = state.decisions.filter((d) => d.status === "open").length;
  return (
    <div className="app">
      <header className="top">
        <button type="button" className="nav-toggle" aria-label="메뉴" aria-expanded={navOpen} onClick={() => setNavOpen((x) => !x)}>☰</button>
        <a className="brand" href="#/all">IAMCEO <small>업무 체험판</small></a>
        <div className="top__badges">
          <Badge tone="ok">로컬 체험판</Badge>
          <Badge>테스트 실행 · 외부 모델 호출 {state.trial.externalModelCalls}건</Badge>
        </div>
        <a className="top__inbox" href="#/inbox">내 차례 <b>{inbox}</b></a>
      </header>
      <div className="body">
        <Nav state={state} route={route} open={navOpen} />
        <main className="main">
          {route.view === "task" ? <TaskView id={route.id} state={state} onChange={reload} />
            : route.view === "inbox" ? <Inbox state={state} onChange={reload} />
            : route.view === "files" ? <Files state={state} />
            : route.view === "roles" ? <Roles state={state} />
            : route.view === "hindsight" ? <Hindsight state={state} onChange={reload} />
            : <TaskList state={state} route={route} onChange={reload} />}
        </main>
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    memoryCode = v.trim(); store.set(CODE_KEY, v.trim());
    try { await api("GET", "/api/state"); onDone(); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
  };
  return (
    <form className="login card" onSubmit={submit}>
      <h1>업무 체험판</h1>
      <p>체험판 전용 접속 코드를 넣어 주세요. 운영 IAMCEO 접속 코드와 다릅니다.</p>
      <input aria-label="체험판 접속 코드" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      <button className="btn btn--primary" type="submit">열기</button>
      {err ? <p className="err">{err}</p> : null}
    </form>
  );
}

function Nav({ state, route, open }: { state: WorkState; route: Route; open: boolean }) {
  const count = (f: (t: WorkTask) => boolean) => state.tasks.filter(f).length;
  const item = (r: Route, label: ReactNode, n?: number) => {
    const on = JSON.stringify(r) === JSON.stringify(route) || (r.view === "all" && route.view === "all");
    return <a key={href(r)} className="nav__item" aria-current={on ? "page" : undefined} href={href(r)}><span>{label}</span>{n !== undefined ? <small>{n}</small> : null}</a>;
  };
  return (
    <nav className={`nav ${open ? "nav--open" : ""}`} aria-label="체험판 메뉴">
      {item({ view: "all" }, "전체 업무", state.tasks.length)}
      {item({ view: "inbox" }, "내 차례", state.decisions.filter((d) => d.status === "open").length)}
      <p className="nav__label">프로젝트 · 일반업무</p>
      {state.projects.map((p) => item({ view: "project", id: p.id }, p.name, count((t) => t.projectId === p.id)))}
      <p className="nav__label">목표 묶음</p>
      {state.goals.map((g) => item({ view: "goal", id: g.id }, g.title, count((t) => t.goalId === g.id)))}
      <p className="nav__label">더 보기</p>
      {item({ view: "files" }, "자료", state.files.length)}
      {item({ view: "roles" }, "역할", state.roles.length)}
      {item({ view: "hindsight" }, "Hindsight 연결")}
    </nav>
  );
}

// ---- 업무 목록 ----
function TaskList({ state, route, onChange }: { state: WorkState; route: Route; onChange: () => void }) {
  const project = route.view === "project" ? state.projects.find((p) => p.id === route.id) : null;
  const goal = route.view === "goal" ? state.goals.find((g) => g.id === route.id) : null;
  const tasks = state.tasks.filter((t) => (project ? t.projectId === project.id : goal ? t.goalId === goal.id : true));
  const ids = new Set(tasks.map((t) => t.id));
  const notes = state.coordination.filter((n) => n.taskIds.some((id) => ids.has(id)));
  const title = project ? project.name : goal ? `목표 · ${goal.title}` : "전체 업무";
  return (
    <section className="stack">
      <div className="head"><h1>{title}</h1><p className="muted">{project?.note ?? goal?.note ?? "프로젝트와 본사 일반업무를 한곳에서 봅니다. 직원을 고르지 않아도 됩니다."}</p></div>
      {notes.length ? (
        <div className="card coord">
          <h2>총괄 종합 <small className="muted">업무 사이 선후·대기·병행만 모읍니다. 대화는 각 업무에서 직접 오갑니다.</small></h2>
          <ul>{notes.map((n, i) => <li key={i} data-kind={n.kind}>{n.text}</li>)}</ul>
        </div>
      ) : null}
      <NewTask state={state} projectId={project?.id ?? null} goalId={goal?.id ?? null} onChange={onChange} />
      <ul className="tasks">
        {tasks.map((t) => <TaskRow key={t.id} t={t} state={state} />)}
        {!tasks.length ? <li className="muted">업무가 없습니다.</li> : null}
      </ul>
    </section>
  );
}

function TaskRow({ t, state }: { t: WorkTask; state: WorkState }) {
  const p = state.projects.find((x) => x.id === t.projectId);
  const g = state.goals.find((x) => x.id === t.goalId);
  const r = state.roles.find((x) => x.id === t.roleId);
  const open = state.decisions.filter((d) => d.taskId === t.id && d.status === "open").length;
  return (
    <li>
      <a className="task card" href={href({ view: "task", id: t.id })} data-task-id={t.id}>
        <div className="task__top"><b>{t.title}</b><StatusBadge s={t.status} /></div>
        <div className="task__meta">
          <span>{p?.name}</span>{g ? <span>목표 · {g.title}</span> : null}<span>역할 · {r?.name}</span>
          {open ? <Badge tone="warn">결재 {open}</Badge> : null}
        </div>
      </a>
    </li>
  );
}

function NewTask({ state, projectId, goalId, onChange }: { state: WorkState; projectId: string | null; goalId: string | null; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [instruction, setInstruction] = useState("");
  const hq = state.projects.find((p) => p.kind === "hq")!;
  const [pid, setPid] = useState(projectId ?? hq.id);
  const [gid, setGid] = useState(goalId ?? "");
  const [roleId, setRoleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const clientId = useRef(newId());
  useEffect(() => { setPid(projectId ?? hq.id); setGid(goalId ?? ""); }, [projectId, goalId]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const t = await api<WorkTask>("POST", "/api/tasks", { title, projectId: pid, goalId: gid || null, roleId: roleId || null, instruction, clientId: clientId.current });
      clientId.current = newId(); setTitle(""); setInstruction(""); setOpen(false); onChange();
      location.hash = href({ view: "task", id: t.id });
    } catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
    finally { setBusy(false); }
  };
  if (!open) return <button type="button" className="btn btn--primary new-btn" onClick={() => setOpen(true)}>+ 새 업무</button>;
  return (
    <form className="card form" onSubmit={submit} aria-label="새 업무">
      <label>업무 제목<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 협력사 미팅 일정 조율" required /></label>
      <div className="row2">
        <label>소속<select value={pid} onChange={(e) => setPid(e.target.value)}>{state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>목표 묶음(선택)<select value={gid} onChange={(e) => setGid(e.target.value)}><option value="">없음</option>{state.goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label>
      </div>
      <label>첫 지시<textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} placeholder="무엇을 해 달라고 할까요?" /></label>
      <details><summary>담당 역할 직접 정하기(선택)</summary>
        <select aria-label="담당 역할" value={roleId} onChange={(e) => setRoleId(e.target.value)}><option value="">자동(제목으로 고름)</option>{state.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      </details>
      <div className="actions"><button className="btn btn--primary" disabled={busy || !title.trim()}>{busy ? "접수 중" : "접수"}</button><button type="button" className="btn" onClick={() => setOpen(false)}>닫기</button></div>
      {err ? <p className="err">{err}</p> : null}
    </form>
  );
}

// ---- 업무 상세 ----
type Pending = { clientId: string; taskId: string; text: string; state: "sending" | "failed"; error?: string };
const pendings = new Map<string, Pending>();
const drafts = new Map<string, string>();

function TaskView({ id, state, onChange }: { id: string; state: WorkState; onChange: () => void }) {
  const { data, error, reload } = usePoll(() => api<TaskDetail>("GET", `/api/tasks/${encodeURIComponent(id)}`), 1500, `task-${id}`);
  const [, force] = useState(0);
  const [viewFile, setViewFile] = useState<WorkFile | null>(null);
  const refresh = () => { reload(); onChange(); };
  if (error) return <p className="err">{error.message}</p>;
  if (!data) return <p className="muted">불러오는 중</p>;
  const t = data.task;
  const p = state.projects.find((x) => x.id === t.projectId);
  const g = state.goals.find((x) => x.id === t.goalId);
  const dep = t.dependsOn ? state.tasks.find((x) => x.id === t.dependsOn) : null;
  const mine = [...pendings.values()].filter((x) => x.taskId === t.id && !data.messages.some((m) => m.clientId === x.clientId));
  const openFile = async (fid: string) => setViewFile(await api<WorkFile>("GET", `/api/files/${encodeURIComponent(fid)}`));
  return (
    <section className="detail">
      <div className="detail__main stack">
        <div className="head">
          <p className="crumbs"><a href={href({ view: "project", id: t.projectId })}>{p?.name}</a>{g ? <> · <a href={href({ view: "goal", id: g.id })}>{g.title}</a></> : null}</p>
          <h1>{t.title} <StatusBadge s={t.status} /></h1>
          <p className="muted">업무 ID <code>{t.id}</code> · 완료 기준: {t.criteria}</p>
          {dep ? <p className="muted">선행 업무: <a href={href({ view: "task", id: dep.id })}>{dep.title}</a> ({STATUS[dep.status]})</p> : null}
        </div>
        <ol className="thread" aria-label="업무 대화">
          {data.messages.map((m) => <Bubble key={m.id} m={m} state={state} onFile={openFile} />)}
          {mine.map((x) => (
            <li key={x.clientId} className="msg msg--owner msg--pending">
              <div className="msg__body">{x.text}</div>
              <small>{x.state === "sending" ? "보내는 중 · 이 업무로 고정됨" : `보내지 못함: ${x.error}`}</small>
              {x.state === "failed" ? <button type="button" className="btn btn--s" onClick={() => void sendText(x.taskId, x.text, x.clientId, () => { force((n) => n + 1); refresh(); })}>같은 내용 다시 보내기</button> : null}
            </li>
          ))}
        </ol>
        <Composer task={t} onSent={() => { force((n) => n + 1); refresh(); }} />
      </div>
      <aside className="detail__side stack">
        <Controls task={t} state={state} onChange={refresh} />
        <DecisionList decisions={data.decisions} onChange={refresh} />
        <div className="card">
          <h2>자료 {data.files.length}</h2>
          {data.files.length ? <ul className="plain">{data.files.map((f) => <li key={f.id}><button type="button" className="link" onClick={() => setViewFile(f)}>{f.title}</button> <small className="muted">{time(f.at)}</small></li>)}</ul> : <p className="muted">아직 없음</p>}
        </div>
        <Runs detail={data} state={state} />
        {data.records.length ? <Records records={data.records} canSend={state.hindsight.config.upload.mode !== "none"} onChange={refresh} /> : null}
      </aside>
      {viewFile ? <FileModal f={viewFile} state={state} onClose={() => setViewFile(null)} /> : null}
    </section>
  );
}

async function sendText(taskId: string, text: string, clientId: string, done: () => void) {
  // 보낼 때의 업무 ID를 고정한다. 다른 업무로 옮겨 가도 이 요청은 원래 업무로 간다. 실패하면 같은 clientId 로 다시 보낸다.
  pendings.set(clientId, { clientId, taskId, text, state: "sending" });
  done();
  try {
    await api<WorkMessage>("POST", `/api/tasks/${encodeURIComponent(taskId)}/messages`, { clientId, text });
    pendings.delete(clientId);
  } catch (e) {
    pendings.set(clientId, { clientId, taskId, text, state: "failed", error: e instanceof Error ? e.message : String(e) });
  }
  done();
}

function Composer({ task, onSent }: { task: WorkTask; onSent: () => void }) {
  const [text, setText] = useState(drafts.get(task.id) ?? "");
  useEffect(() => { setText(drafts.get(task.id) ?? ""); }, [task.id]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    drafts.delete(task.id); setText("");
    void sendText(task.id, v, newId(), onSent);
  };
  return (
    <form className="composer card" onSubmit={submit}>
      <textarea aria-label={`${task.title}에 보낼 지시`} value={text} rows={2} placeholder={task.status === "done" ? "보내면 이 업무를 다시 열고 이어 갑니다" : `'${task.title}'에 후속 지시`}
        onChange={(e) => { setText(e.target.value); drafts.set(task.id, e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e as unknown as FormEvent); }} />
      <button className="btn btn--primary" disabled={!text.trim()}>보내기</button>
    </form>
  );
}

function linkify(body: string, state: WorkState, onFile: (id: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[(file|decision):([\w-]+)\]/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    out.push(body.slice(last, m.index));
    const [, kind, id] = m;
    if (kind === "file") out.push(<button key={m.index} type="button" className="link" onClick={() => onFile(id!)}>자료 열기</button>);
    else out.push(<a key={m.index} href="#/inbox">{state.decisions.find((d) => d.id === id)?.status === "open" ? "내 차례에서 답하기" : "결재 보기"}</a>);
    last = m.index + m[0].length;
  }
  out.push(body.slice(last));
  return out;
}

function Bubble({ m, state, onFile }: { m: WorkMessage; state: WorkState; onFile: (id: string) => void }) {
  const peer = m.peerTaskId ? state.tasks.find((t) => t.id === m.peerTaskId) : null;
  const label = m.author === "owner" ? "대표" : m.author === "system" ? "시스템" : m.kind === "late" ? "늦은 결과(반영 안 함)" : m.kind.startsWith("collab") ? "업무 간 협업" : "담당 실행";
  return (
    <li className={`msg msg--${m.author} msg--${m.kind}`} data-kind={m.kind}>
      <small className="msg__who">{label}{m.runId ? <> · <code>{m.runId.slice(-6)}</code></> : null} · {time(m.at)}</small>
      <div className="msg__body">{linkify(m.body, state, onFile)}</div>
      {peer ? <small><a href={href({ view: "task", id: peer.id })}>↔ {peer.title}</a></small> : null}
    </li>
  );
}

function Controls({ task, state, onChange }: { task: WorkTask; state: WorkState; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); onChange(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const id = encodeURIComponent(task.id);
  return (
    <div className="card">
      <h2>담당·실행</h2>
      <label>담당 역할<select value={task.roleId} disabled={busy} onChange={(e) => void act(() => api("POST", `/api/tasks/${id}/role`, { roleId: e.target.value }))}>{state.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label>모델(테스트)<select value={task.model} disabled={busy} onChange={(e) => void act(() => api("POST", `/api/tasks/${id}/model`, { model: e.target.value }))}>{state.models.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
      <p className="muted small">바꾸면 지금 실행을 끝내고, 이 업무의 기록만 새 실행에 인계합니다.</p>
      <div className="actions">
        {task.status === "done"
          ? <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api("POST", `/api/tasks/${id}/resume`, {}))}>재개</button>
          : <button type="button" className="btn btn--primary" disabled={busy || task.status === "waiting_dep"} onClick={() => void act(() => api("POST", `/api/tasks/${id}/complete`, {}))}>완료</button>}
      </div>
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}

const answerOps = new Map<string, string>();
function DecisionCard({ d, onChange, source }: { d: WorkDecision; onChange: () => void; source?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answer = async (k: string) => {
    // 응답을 못 받으면 같은 operationId 로 다시 보낸다. 서버가 같은 결과를 돌려준다.
    const op = answerOps.get(`${d.id}:${k}`) ?? newId();
    answerOps.set(`${d.id}:${k}`, op);
    setBusy(true); setErr(null);
    try { await api("POST", `/api/decisions/${encodeURIComponent(d.id)}/answer`, { operationId: op, optionKey: k }); onChange(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className={`card decision ${d.status === "open" ? "decision--open" : ""}`} data-decision-id={d.id}>
      {source}
      <b>{d.title}</b>
      <p className="muted">{d.detail}</p>
      {d.status === "open"
        ? <div className="actions">{d.options.map((o) => <button key={o.k} type="button" className="btn" disabled={busy} onClick={() => void answer(o.k)}>{o.label}</button>)}</div>
        : <p><Badge tone="ok">답함</Badge> {d.answer} <small className="muted">{d.answeredAt ? time(d.answeredAt) : ""}</small></p>}
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}
function DecisionList({ decisions, onChange }: { decisions: WorkDecision[]; onChange: () => void }) {
  return (
    <div className="stack">
      <h2 className="side-h">결재 {decisions.filter((d) => d.status === "open").length ? <Badge tone="warn">열림 {decisions.filter((d) => d.status === "open").length}</Badge> : null}</h2>
      {decisions.length ? decisions.map((d) => <DecisionCard key={d.id} d={d} onChange={onChange} />) : <p className="muted">없음</p>}
    </div>
  );
}

function Runs({ detail, state }: { detail: TaskDetail; state: WorkState }) {
  return (
    <div className="card">
      <h2>실행 이력 {detail.runs.length}</h2>
      <p className="muted small">실행마다 입력 기록이 따로 있습니다. 테스트 실행기는 이 기록만 받습니다.</p>
      {detail.runs.slice().reverse().map((r) => (
        <details key={r.id} className="run" open={r.status === "active"} data-run-id={r.id}>
          <summary><code>{r.id.slice(-6)}</code> {r.status === "active" ? <Badge tone="accent">지금 실행</Badge> : <Badge>끝남</Badge>} {state.roles.find((x) => x.id === r.roleId)?.name} · {r.model} · {REASON[r.reason]} · 입력 {r.inputs.length}</summary>
          <ol className="inputs">
            {r.inputs.map((i) => <li key={i.id}><small>{SOURCE[i.source]}{i.state === "pending" ? " · 대기" : ""}</small><div>{i.text}</div><small className="muted">검색 범위: {i.searchContext?.status === "not_configured" ? "Hindsight 연결 전" : `${i.searchContext?.bindingRef} (미확인)`} · 업무 {i.searchContext?.scope.taskRef.slice(-6)}</small></li>)}
          </ol>
        </details>
      ))}
    </div>
  );
}

function Records({ records, canSend, onChange }: { records: HindsightRecordView[]; canSend: boolean; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="card">
      <h2>Hindsight 기록</h2>
      {!canSend ? <p className="muted small">Hindsight 연결 전이라 보내지 않고 보관만 합니다.</p> : null}
      <ul className="plain">
        {records.map((r) => (
          <li key={r.id} data-record-id={r.id}>
            <b>{r.kind === "verified_record" ? "검증된 기록" : r.kind === "retrospective" ? "회고" : "개선 후보"}</b> · {r.revision}판 · <Badge tone={r.status === "uploaded" ? "ok" : r.status === "failed" ? "danger" : r.status === "unknown" ? "warn" : "plain"}>{HS[r.status]}{r.adapter === "test" ? "(시험 대역)" : ""}</Badge>
            {r.status !== "uploaded" && canSend ? <button type="button" className="btn btn--s" onClick={() => void api("POST", `/api/hindsight/records/${r.id}/retry`, {}).then(onChange, (e) => setErr(String(e.message)))}>같은 판으로 다시 보내기</button> : null}
            {r.lastError ? <div className="muted small">{r.lastError}</div> : null}
          </li>
        ))}
      </ul>
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}

function FileModal({ f, state, onClose }: { f: WorkFile; state: WorkState; onClose: () => void }) {
  const t = state.tasks.find((x) => x.id === f.taskId);
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label={f.title} onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head"><b>{f.title}</b><button type="button" className="btn btn--s" onClick={onClose}>닫기</button></div>
        <p className="muted small">출처 업무: {t ? <a href={href({ view: "task", id: t.id })} onClick={onClose}>{t.title}</a> : f.taskId} · 실행 <code>{f.runId.slice(-6)}</code></p>
        <Md text={f.content} />
      </div>
    </div>
  );
}

// ---- 내 차례·자료·역할·Hindsight ----
function Inbox({ state, onChange }: { state: WorkState; onChange: () => void }) {
  const open = state.decisions.filter((d) => d.status === "open");
  const answered = state.decisions.filter((d) => d.status === "answered").slice(-6).reverse();
  const src = (d: WorkDecision) => {
    const t = state.tasks.find((x) => x.id === d.taskId);
    const p = t ? state.projects.find((x) => x.id === t.projectId) : null;
    return <p className="small muted">{p?.name} · 업무 <a href={href({ view: "task", id: d.taskId })}>{t?.title ?? d.taskId}</a> (돌아가기)</p>;
  };
  return (
    <section className="stack">
      <div className="head"><h1>내 차례</h1><p className="muted">프로젝트와 일반업무에서 대표 답을 기다리는 결재를 모았습니다. 답은 그 안건에만 적용됩니다.</p></div>
      {open.length ? open.map((d) => <DecisionCard key={d.id} d={d} onChange={onChange} source={src(d)} />) : <p className="muted card">지금 답할 결재가 없습니다.</p>}
      {answered.length ? <><h2>최근 답한 결재</h2>{answered.map((d) => <DecisionCard key={d.id} d={d} onChange={onChange} source={src(d)} />)}</> : null}
    </section>
  );
}

function Files({ state }: { state: WorkState }) {
  const [f, setF] = useState<WorkFile | null>(null);
  return (
    <section className="stack">
      <div className="head"><h1>자료</h1><p className="muted">모든 자료에 출처 업무가 붙어 있습니다.</p></div>
      <ul className="plain card">
        {state.files.slice().reverse().map((x) => {
          const t = state.tasks.find((y) => y.id === x.taskId);
          return <li key={x.id}><button type="button" className="link" onClick={() => void api<WorkFile>("GET", `/api/files/${x.id}`).then(setF)}>{x.title}</button> <small className="muted">· <a href={href({ view: "task", id: x.taskId })}>{t?.title}</a> · {time(x.at)}</small></li>;
        })}
      </ul>
      {f ? <FileModal f={f} state={state} onClose={() => setF(null)} /> : null}
    </section>
  );
}

function Roles({ state }: { state: WorkState }) {
  return (
    <section className="stack">
      <div className="head"><h1>역할</h1><p className="muted">역할은 재사용 정의입니다. 같은 역할이 여러 업무를 맡아도 업무마다 실행(문맥)이 따로 있습니다.</p></div>
      {state.roles.map((r) => {
        const ts = state.tasks.filter((t) => t.roleId === r.id);
        return (
          <div key={r.id} className="card">
            <b>{r.name}</b> <small className="muted">{r.description} · 기본 모델 {r.defaultModel}</small>
            <ul className="plain">{ts.map((t) => <li key={t.id}><a href={href({ view: "task", id: t.id })}>{t.title}</a> <StatusBadge s={t.status} /> <small className="muted">실행 {t.activeRunId ? <code>{t.activeRunId.slice(-6)}</code> : "없음"}</small></li>)}</ul>
          </div>
        );
      })}
    </section>
  );
}

function Hindsight({ state, onChange }: { state: WorkState; onChange: () => void }) {
  const [cfg, setCfg] = useState<HindsightConfig>(state.hindsight.config);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault(); setMsg(null);
    try { await api("PUT", "/api/hindsight/config", cfg); setMsg("저장했습니다"); onChange(); } catch (x) { setMsg(x instanceof Error ? x.message : String(x)); }
  };
  const up = cfg.upload, se = cfg.search;
  return (
    <section className="stack">
      <div className="head"><h1>Hindsight 연결</h1><p className="muted">대표님이 구축 중인 Hindsight 서버 업로드와 MCP 검색에 연결할 자리만 준비했습니다. 실제 계약(주소·형식·인증·도구 이름)을 받기 전에는 보내거나 검색하지 않습니다.</p></div>
      <div className="grid2">
        <div className="card"><h2>업로드</h2><p>{state.hindsight.uploadState}</p></div>
        <div className="card"><h2>MCP 검색</h2><p>{state.hindsight.searchState}</p></div>
      </div>
      <form className="card form" onSubmit={save} aria-label="Hindsight 설정">
        <label>업로드 방식<select value={up.mode} onChange={(e) => setCfg({ ...cfg, upload: { ...up, mode: e.target.value as HindsightConfig["upload"]["mode"] } })}>
          <option value="none">연결 안 함(기본, 외부 호출 없음)</option>
          <option value="test_success">시험 대역 · 성공</option><option value="test_fail">시험 대역 · 실패</option><option value="test_lost">시험 대역 · 응답 유실</option>
          <option value="external">실제 서버(계약 받기 전이라 보내지 않음)</option>
        </select></label>
        <div className="row2">
          <label>업로드 주소 참조<input value={up.endpointRef ?? ""} onChange={(e) => setCfg({ ...cfg, upload: { ...up, endpointRef: e.target.value } })} placeholder="예: env:HINDSIGHT_URL" /></label>
          <label>업로드 인증 참조<input value={up.authRef ?? ""} onChange={(e) => setCfg({ ...cfg, upload: { ...up, authRef: e.target.value } })} placeholder="예: env:HINDSIGHT_TOKEN (값 아님)" /></label>
        </div>
        <div className="row2">
          <label>MCP 서버 참조<input value={se.mcpServerRef ?? ""} onChange={(e) => setCfg({ ...cfg, search: { ...se, mcpServerRef: e.target.value } })} placeholder="예: hindsight" /></label>
          <label>MCP 검색 도구 이름<input value={se.toolRef ?? ""} onChange={(e) => setCfg({ ...cfg, search: { ...se, toolRef: e.target.value } })} placeholder="실제 도구 이름(미확인)" /></label>
        </div>
        <div className="actions"><button className="btn btn--primary">저장</button>{msg ? <span className="muted">{msg}</span> : null}</div>
      </form>
      <div className="card">
        <h2>보낼 기록 {state.hindsight.records.length}</h2>
        <p className="muted small">업무를 완료하면 검증된 기록·회고 초안이 생깁니다. 중복 키 = 체험 인스턴스 + 기록 ID + 판.</p>
        <table className="tbl"><thead><tr><th>업무</th><th>종류</th><th>판</th><th>상태</th><th>시도</th></tr></thead>
          <tbody>{state.hindsight.records.map((r) => <tr key={r.id}><td><a href={href({ view: "task", id: r.taskId })}>{state.tasks.find((t) => t.id === r.taskId)?.title}</a></td><td>{r.kind}</td><td>{r.revision}</td><td>{HS[r.status]}{r.adapter === "test" ? "(시험)" : ""}</td><td>{r.attempts}</td></tr>)}</tbody></table>
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
