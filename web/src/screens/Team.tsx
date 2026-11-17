import { deliveryWaitText, memberIssueLabel, providerIssueKind } from "@shared/execution-issues";
// 팀 요약·전체 지도. 직원 상세는 기존 주소의 <sub>(직원 id)로 열린다.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { CODEX_EFFORTS, EFFORTS, memberRank, type CodexSpeed, type ModelList, type Activity, type DeliveryNoticeItem, type DeliveryNoticePage, type ActivityKind, type CliProvider, type Effort, type Member, type MemberStatus, type PatchMemberReq, type Project, type ProjectState, type Task, type WorkItem, type WorkSec } from "@shared/types";
import type { WorkflowNode } from "@shared/workflow";
import { ProviderSelect, RuntimeDetails, providerName, runtimeBlock, useRuntime } from "../components/RuntimeStatus";
import { PROVIDERS } from "../lib/runtime";
import ApprovalPanel from "../components/ApprovalPanel";
import WorkFlow, {useWorkflowNodes} from "../components/WorkFlow";
import TeamTaskList, {teamTaskScope, type TeamTaskTab} from "../components/TeamTaskList";
import { enterSends, isComposing } from "../components/Composer";
import ConnectGate, { useGate } from "../components/ConnectGate";
import { Badge, MQ_DESKTOP, Modal, Drawer, Sheet, StatusDot, Time, copyText, formatTime, useConfirmPress, useMediaQuery, Markdown } from "../components/ui";
import { Glass, GlassButton, cx } from "../glass";
import { ApiError, api, errorText } from "../lib/api";
import { applyLocal, findMember, getState, loadActivity, navigate, newId, refresh, routeHash, useBootstrap, useProject, useRoute, useStore } from "../lib/store";
import { ReviewRequiredError, captureWriteReview, executeReviewedWrite, reviewStillCurrent, type WriteReview } from "../lib/reviewed-writes";
import { readWriteContext, useWriteContext } from "../lib/review-context";
import { chooseTask, memberSubmissions, useSubmissionDraft } from "../lib/submission-client";
import { canStop, runLabel, stopExpectation, stopNotice } from "../lib/stop";
import { isLocalTerminalHost, terminalCommand } from "../lib/terminal-command";
import { SEC_LABEL, hasTaskRows, workRows, type WorkRow } from "../lib/task-list";
import "../styles/team.css";

const SCREEN_POLL_MS = 2000;
const CLOCK_TICK_MS = 30_000;
const ACTIVITY_SHOWN = 200;
const LONG_ACTIVITY = 180;

const SECS: readonly WorkSec[] = ["doing", "next", "hold", "done"];

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  text: "글",
  tool: "도구",
  tool_result: "결과",
  turn_start: "시작",
  turn_end: "끝",
  compact: "압축",
  error: "오류",
  system: "알림",
};

const DELIVERY_LABEL = { queued: "전달 대기", delivering: "전달 중", held: "보류", delivered: "받음", failed: "실패" } as const;

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run, setError };
}

function ErrorLine({ children }: { children: ReactNode }) {
  return children ? (
    <p className="tm-error" role="alert">
      {children}
    </p>
  ) : null;
}

// ---- 시작 안내 ----

function StartPanel({ project, hasMembers }: { project: Project; hasMembers: boolean }) {
  const { busy, error, run } = useAction();
  const gate = useGate();
  const diagnostics = useRuntime();
  const blocked = runtimeBlock(diagnostics.runtime);
  const canStart = (gate.ok || gate.kind === "runner_off") && !blocked;
  const start = () => run("start", async () => {
    applyLocal({ type: "member", member: await api.startConductor(project.id) });
    await refresh();
  });
  return (
    <Glass as="section" level="regular" tint className="tm-start">
      <h2 className="tm-start__title">{project.runnerEnabled ? "아직 팀이 없습니다" : "총괄을 시작하세요"}</h2>
      <p className="tm-start__text">{blocked ?? (!gate.ok && gate.kind !== "runner_off" ? gate.detail : hasMembers ? "총괄을 시작하면 팀이 다시 일을 이어갑니다." : "총괄이 일을 받아 Claude Code·Codex·Antigravity 직원을 꾸립니다.")}</p>
      <div className="tm-start__actions">
        <GlassButton variant="primary" size="m" disabled={busy !== null || !canStart} onClick={start}>{busy === "start" ? "시작하는 중" : "총괄 시작"}</GlassButton>
      </div>
      {blocked ? <RuntimeDetails diagnostics={diagnostics} /> : null}
      <ErrorLine>{error}</ErrorLine>
    </Glass>
  );
}

function CreateMember({ project, onDismiss }: { project: Project; onDismiss?: () => void }) {
  const members = useProject()?.members ?? [];
  const inheritedCli = members.find(member => member.kind === "conductor" || member.kind === "root")?.cli ?? project.chiefCli ?? "claude";
  const [open, setOpen] = useState(!!onDismiss);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [cli, setCli] = useState<CliProvider>(inheritedCli);
  const [model, setModel] = useState("");
  const { busy, error, run, setError } = useAction();
  const diagnostics = useRuntime();
  const gate = useGate();
  const blocked = runtimeBlock(diagnostics.runtime, cli) ?? (!gate.ok ? gate.detail : null);
  const Overlay = useMediaQuery(MQ_DESKTOP) ? Modal : Sheet;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocked || busy) return;
    if (!name.trim()) return setError("직원 이름을 넣어 주세요");
    void run("create", async () => {
      applyLocal({ type: "member", member: await api.createMember(project.id, { name: name.trim(), role: role.trim() || undefined, cli, modelOverride: model.trim() || null }) });
      await refresh();
      setOpen(false); onDismiss?.();
      setName(""); setRole(""); setModel("");
    });
  };
  return (
    <div className="tm-adopt-entry">
      {!onDismiss ? <GlassButton variant="glass" size="m" onClick={() => { setError(null); setCli(inheritedCli); setOpen(true); }}>직원 추가</GlassButton> : null}
      <Overlay open={open} onClose={() => { if (!busy) { setOpen(false); onDismiss?.(); } }} title="직원 추가">
        <form className="form" onSubmit={submit}>
          <label className="field"><span className="field__label">이름</span><input className="input" value={name} disabled={!!busy} onChange={(e) => setName(e.target.value)} placeholder="개발 담당" data-autofocus="" /></label>
          <label className="field"><span className="field__label">역할 · 선택</span><input className="input" value={role} disabled={!!busy} onChange={(e) => setRole(e.target.value)} placeholder="결제 화면 구현" /></label>
          <ProviderSelect value={cli} onChange={setCli} runtime={diagnostics.runtime} disabled={!!busy} />
          <label className="field"><span className="field__label">모델 · 선택</span><input className="input t-code" value={model} disabled={!!busy} onChange={(e) => setModel(e.target.value)} placeholder="CLI 기본값" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></label>
          {blocked ? <><p className="su-hint" role="status">{blocked}</p><RuntimeDetails diagnostics={diagnostics} /></> : null}
          <ErrorLine>{error}</ErrorLine>
          <div className="form__actions"><GlassButton variant="ghost" size="m" disabled={!!busy} onClick={() => setOpen(false)}>취소</GlassButton><GlassButton variant="primary" size="m" type="submit" disabled={!!busy || !!blocked || !name.trim()}>{busy ? "추가하는 중" : "추가"}</GlassButton></div>
        </form>
      </Overlay>
    </div>
  );
}

// ---- 카드 ----

function ContextMeter({ pct, compactAt }: { pct: number; compactAt: number }) {
  const value = Math.round(pct);
  const due = value >= compactAt;
  return (
    <span className="tm-ctx" data-due={due ? "" : undefined}>
      <i className="tm-ctx__bar" aria-hidden="true">
        <b style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </i>
      <span className="t-tabular">{value}%</span>
      {due ? <Badge tone="warn">압축 기준 도달</Badge> : null}
    </span>
  );
}

function MemoryRow({ project }: { project: Project }) {
  const service = useBootstrap()?.runtime?.memory ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memory = project.memory;
  if (!memory || project.isHq) return null;
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      applyLocal({ type: "project", project: await api.patchProject(project.id, { memory: !memory.on }) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const link = !service || service.state === "not_configured" ? "서버 연결 설정 없음"
    : service.state === "ok" ? "연결됨"
    : service.state === "unknown" ? "연결 확인 전"
    : service.state === "key_unreadable" ? "연결 키를 못 읽음"
    : "서버가 응답하지 않음";
  return (
    <Row label="개발 기억">
      <span data-memory={memory.on ? "on" : "off"}>{memory.on ? `켜짐 · ${link}` : "꺼짐"}</span>{" "}
      <GlassButton variant="ghost" size="s" onClick={() => void toggle()} disabled={busy}>
        {busy ? "바꾸는 중" : memory.on ? "끄기" : "켜기"}
      </GlassButton>
      {error ? <span className="form__error" role="alert"> {error}</span> : null}
    </Row>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** 지금 · 다음 · 대기열 · 문맥. 카드와 상세가 같은 줄을 쓴다 */
function MemberFacts({ m, compactAt, openAsks, extra }: { m: Member; compactAt: number; openAsks: number; extra?: ReactNode }) {
  const state = useProject();
  const current = state?.workflow?.nodes.find((node) => node.memberId === m.id && node.current);
  const task = current ? state?.tasks?.find((item) => item.id === current.taskId) : null;
  const waitReason = !memberIssueLabel(m) && m.queuedCount > 0
    ? current?.inputBlock ? current.reason : m.deliveryWait ? deliveryWaitText(m.deliveryWait).reason : current?.state === "waiting" || current?.state === "blocked" ? current.reason : null
    : null;
  return (
    <dl className="tm-facts">
      {extra}
      {current && task ? <Row label="현재 업무"><a className="tm-inlink" href={routeHash({ projectId: m.projectId, tab: "thread" })} onClick={() => chooseTask(m.projectId, task)}>{task.title}</a></Row> : null}
      {/* now is a staff self-report, not evidence that a particular task is executing. */}
      {m.now ? <Row label="마지막 보고">{m.now}</Row> : null}
      {m.next ? <Row label="다음">{m.next}</Row> : null}
      {/* 보류(보호·수신 불확실·보관)는 자동으로 들어가지 않는다. 실행할 입력과 나눠 센다. */}
      {m.queuedCount > 0 ? <Row label="입력"><span className="t-tabular">{queueText(m, state?.workflow?.nodes)}</span></Row> : null}
      {waitReason ? <Row label="대기 이유">{waitReason}</Row> : null}
      {m.contextPct !== null ? (
        <Row label="문맥">
          <ContextMeter pct={m.contextPct} compactAt={compactAt} />
        </Row>
      ) : null}
      {openAsks > 0 ? (
        <Row label="결재">
          <a className="tm-inlink" href={routeHash({ projectId: m.projectId, tab: "inbox" })}>
            {openAsks}건 대기 · 결재함으로
          </a>
        </Row>
      ) : null}
    </dl>
  );
}

function StaffStatus({ m, label = false }: { m: Member; label?: boolean }) {
  const issue = memberIssueLabel(m);
  const wait = m.status === "idle" && m.queuedCount && m.deliveryWait ? deliveryWaitText(m.deliveryWait).label : undefined;
  return <StatusDot status={issue ? "error" : m.status} label={label} text={issue ?? wait} className="tm-status" />;
}

function Subagents({ n }: { n: number }) {
  return n > 0 ? <span className="tm-sub t-tabular">서브에이전트 {n}개</span> : null;
}

function NoTools({ m }: { m: Member }) {
  if (m.origin !== "adopted" && (!m.backend || m.backend === "core")) return null;
  return <p className="tm-notools tm-notools__text" role="status">이전 실행기의 세션입니다. 기존 터미널에서 확인하세요. herdr-core에서는 기존 세션 편입과 도구를 붙여 다시 열기를 지원하지 않습니다.</p>;
}

function queueText(m: Member, nodes?: readonly WorkflowNode[]): string {
  if (nodes) {
    const counts = nodes.filter((node) => node.memberId === m.id).reduce((sum, node) => ({ queued: sum.queued + node.counts.queued, held: sum.held + node.counts.held, notices: sum.notices + node.counts.notices }), { queued: 0, held: 0, notices: 0 });
    const other = Math.max(0, m.queuedCount - counts.queued - counts.held - counts.notices);
    return [counts.queued ? `전달 대기 ${counts.queued}` : "", counts.held ? `보류 ${counts.held}` : "", counts.notices ? `알림 ${counts.notices}` : "", other ? `기타 ${other}` : ""].filter(Boolean).join(" · ");
  }
  const held = m.heldCount ?? 0;
  return held > 0 ? [m.queuedCount - held > 0 ? `대기 ${m.queuedCount - held}` : "", `보류 ${held}`].filter(Boolean).join(" · ") : `${m.queuedCount}건`;
}

/** 진행판 항목과 대화 업무를 한 목록으로(같은 업무 id 의 단계). 화면 공통 규칙은 lib/task-list. */
function WorkList({ work, tasks }: { work: WorkItem[]; tasks: readonly Task[] }) {
  const [sec, setSec] = useState<WorkSec | "all">("all");
  const rows = useMemo(() => workRows(work, tasks, Date.now()), [work, tasks]);
  const count = (s: WorkSec) => rows.filter((w) => w.sec === s).length;
  const shown = useMemo(() => {
    const rank = (w: WorkRow) => SECS.indexOf(w.sec);
    const list = rows.filter((w) => (sec === "all" ? w.sec !== "done" : w.sec === sec));
    if (sec === "done") return list.sort((a, b) => (b.doneAt ?? b.at).localeCompare(a.doneAt ?? a.at));
    return list.sort((a, b) => rank(a) - rank(b) || a.order - b.order || b.at.localeCompare(a.at));
  }, [rows, sec]);
  const chip = (key: WorkSec | "all", label: string, n?: number) => (
    <button key={key} type="button" className="tm-chip" aria-pressed={sec === key} onClick={() => setSec(key)}>
      {label}
      {n === undefined ? null : <span className="t-tabular tm-chip__n">{n}</span>}
    </button>
  );
  return (
    <section className="tm-work" aria-label="일 목록">
      <div className="tm-chips">
        {chip("all", "전체")}
        {SECS.map((s) => chip(s, SEC_LABEL[s], count(s)))}
      </div>
      <Glass as="ul" level="regular" tint className="tm-work__list">
        {shown.map((w) => (
          <li key={w.key} className="tm-wi" data-sec={w.sec} data-stage={w.stage ?? undefined}>
            <i className="tm-wi__dot" aria-hidden="true" />
            <div className="tm-wi__main">
              <p className="tm-wi__title">{w.title}</p>
              <p className="tm-wi__sub">{[w.who, w.detail].filter(Boolean).join(" · ")}</p>
              {w.next ? <p className="tm-wi__next">{w.next}</p> : null}
            </div>
            <span className="tm-wi__sec">{w.sec === "done" && w.doneAt ? <Time iso={w.doneAt} relative /> : w.label}</span>
          </li>
        ))}
        {shown.length === 0 ? <li className="tm-note">없음</li> : null}
      </Glass>
    </section>
  );
}

// ---- 직원 상세 ----

function ActivityRow({ a }: { a: Activity }) {
  const long = a.text.length > LONG_ACTIVITY || a.text.includes("\n");
  const [open, setOpen] = useState(false);
  const body = <span className={cx("tm-act__text", (a.kind === "tool" || a.kind === "tool_result") && "t-code", long && !open && "tm-act__text--cut")}>{a.text}</span>;
  return (
    <li className="tm-act" data-kind={a.kind}>
      <span className="tm-act__meta">
        <span className="t-tabular">{formatTime(a.at)}</span>
        <span className="tm-act__kind">{ACTIVITY_LABEL[a.kind]}</span>
      </span>
      {long ? (
        <button type="button" className="tm-act__more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  );
}

function ActivityList({ memberId }: { memberId: string }) {
  const rows = useStore((s) => s.activity[memberId]);
  const online = useStore((s) => s.connection === "online");
  const [error, setError] = useState<string | null>(null);

  // 끊긴 동안 놓친 활동은 이벤트로 다시 오지 않는다: 다시 이어지면 새로 받는다
  useEffect(() => {
    let live = true;
    setError(null);
    loadActivity(memberId).catch((e) => {
      if (live) setError(errorText(e));
    });
    return () => {
      live = false;
    };
  }, [memberId, online]);

  const shown = useMemo(() => (rows ?? []).slice(-ACTIVITY_SHOWN).reverse(), [rows]);
  if (!rows) return error ? <ErrorLine>{error}</ErrorLine> : <p className="tm-note">불러오는 중입니다</p>;
  if (shown.length === 0) return <p className="tm-note">아직 활동이 없습니다</p>;
  return (
    <ol className="tm-acts" aria-live="polite" aria-relevant="additions">
      {shown.map((a) => (
        <ActivityRow key={a.id} a={a} />
      ))}
    </ol>
  );
}

function ScreenPane({ memberId }: { memberId: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const r = await api.screen(memberId);
          if (!live) return;
          setText(stripAnsi(r.text));
          setError(null);
        } catch (e) {
          if (!live) return;
          setError(errorText(e));
        }
      }
      if (live) timer = setTimeout(tick, SCREEN_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [memberId]);

  // 터미널처럼 맨 아래를 따라가되, 위로 올려 읽는 중이면 건드리지 않는다
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="tm-screen-wrap">
      {error ? <ErrorLine>화면을 읽지 못했습니다: {error}</ErrorLine> : null}
      {text === null && !error ? <p className="tm-note">화면을 읽는 중입니다</p> : null}
      {text !== null ? (
        <pre
          ref={ref}
          className="tm-screen t-code"
          tabIndex={0}
          aria-label="터미널 화면"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {text || "화면이 비어 있습니다"}
        </pre>
      ) : null}
    </div>
  );
}

type TerminalKeyName = "enter" | "up" | "down" | "esc" | "tab" | "ctrl+c" | "backspace";
const TERMINAL_KEYS: { key: TerminalKeyName; label: string }[] = [
  { key: "enter", label: "Enter" }, { key: "up", label: "↑" }, { key: "down", label: "↓" }, { key: "tab", label: "Tab" },
  { key: "esc", label: "Esc" }, { key: "ctrl+c", label: "Ctrl+C" }, { key: "backspace", label: "⌫" },
];

/**
 * 웹에서 직원 터미널에 글·키를 넣는다. 서버가 조작권·세션 세대·입력 순번을 확인하는 경로(총괄의 terminal_input 과 같다)만 쓴다.
 * 응답을 잃으면 같은 입력은 같은 operationId 로 다시 확인해 두 번 들어가지 않게 한다.
 */
function TerminalInput({ member }: { member: Member }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pending = useRef<{ op: string; payload: string } | null>(null);
  const working = member.status === "working";
  const send = async (payload: { text?: string; key?: TerminalKeyName }) => {
    const key = JSON.stringify(payload);
    const op = pending.current?.payload === key ? pending.current.op : `web-${newId()}`;
    pending.current = { op, payload: key };
    setBusy(true);
    try {
      const r = await api.terminalSend(member.id, { operationId: op, ...payload });
      pending.current = null;
      if (r.status === "applied") { setNote("넣었습니다. 위 화면에서 결과를 확인하세요"); if (payload.text) setText(""); }
      else if (r.status === "unknown") setNote("들어갔는지 확실하지 않습니다. 화면을 먼저 확인하세요");
      else setNote(`넣지 못했습니다: ${r.error ?? "거절"}`);
    } catch (e) {
      setNote(`보내지 못했습니다: ${errorText(e)}. 같은 버튼을 다시 누르면 같은 입력인지 서버가 확인합니다`);
    } finally { setBusy(false); }
  };
  return (
    <div className="tm-term-input">
      <form className="tm-term-input__row" onSubmit={(e) => { e.preventDefault(); if (text.trim() && !working) void send({ text }); }}>
        <input className="input t-code" aria-label="터미널에 넣을 글" value={text} disabled={busy || working} onChange={(e) => setText(e.target.value)} placeholder={working ? "일하는 중에는 글을 보내지 않습니다(키만)" : "보내면 바로 제출됩니다(직원에게 메시지로 감)"} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <GlassButton variant="primary" size="m" type="submit" disabled={busy || working || !text.trim()}>{busy ? "보내는 중" : "보내기"}</GlassButton>
      </form>
      <div className="tm-term-input__keys" role="group" aria-label="터미널 키">
        {TERMINAL_KEYS.map((k) => <GlassButton key={k.key} variant="glass" size="s" disabled={busy} onClick={() => void send({ key: k.key })}>{k.label}</GlassButton>)}
      </div>
      {note ? <p className="tm-note tm-note--left" role="status">{note}</p> : null}
    </div>
  );
}

/** 명령 한 줄과 복사 버튼. */
function CopyBox({ command, label, resolveCommand, onCopied }: { command: string | null; label: string; resolveCommand: () => Promise<string>; onCopied?: () => void }) {
  const [state, setState] = useState<"idle" | "copying" | "ok" | "fail">("idle");
  const [resolvedCommand, setResolvedCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current !== null) clearTimeout(resetTimer.current); }, []);
  useEffect(() => { setResolvedCommand(null); }, [command]);
  const copy = async () => {
    if (state === "copying") return;
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    setState("copying"); setError(null);
    try {
      const current = resolveCommand().then(value => { setResolvedCommand(value); return value; });
      const ok = await copyText(current);
      setState(ok ? "ok" : "fail");
      if (ok) onCopied?.();
      else setError("클립보드에 복사하지 못했습니다");
    } catch (e) { setState("fail"); setError(errorText(e)); }
    resetTimer.current = setTimeout(() => setState("idle"), 2000);
  };
  return (
    <div className="tm-copy__row">
      <code className="tm-copy__cmd t-code" title={resolvedCommand ?? command ?? undefined}>
        {resolvedCommand ?? command}
      </code>
      <GlassButton variant="glass" size="m" ariaLabel={label} onClick={copy} disabled={state === "copying"}>
        {state === "ok" ? "복사함" : state === "fail" ? "실패" : "복사"}
      </GlassButton>
      {error ? <p className="tm-note tm-note--left" role="alert">{error}</p> : null}
    </div>
  );
}

function CopyCommand({ m }: { m: Member }) {
  const [copied, setCopied] = useState(false);
  const running = m.status !== "asleep" && m.status !== "offline";
  const bootstrap = useBootstrap();
  const attached = m.backend === "core" && !!m.paneId;
  const local = isLocalTerminalHost(window.location.hostname);
  const command = bootstrap?.connection ? terminalCommand(m, bootstrap.connection, local) : null;
  return (
    <div className="tm-copy">
      <p className="tm-label">{attached ? "연결된 터미널 열기" : "터미널로 열기"}</p>
      <CopyBox command={command} label="터미널로 열기 명령 복사" resolveCommand={async () => terminalCommand(m, await api.connection(), local)} onCopied={() => setCopied(true)} />
      {copied && running && !attached ? <p className="tm-note tm-note--left">지금 도는 세션입니다. 두 곳에서 함께 쓰면 꼬이니 먼저 잠재우고 여세요.</p> : null}
    </div>
  );
}

const MODELS = ["fable", "opus", "sonnet", "haiku"];
// agy 모델 이름에 effort 가 들어 있다(gemini-4-argon-high 등). 서버 목록과 같은 값.
const ANTIGRAVITY_MODELS = ["gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-low", "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "claude-opus-5-5-medium", "claude-sonnet-5-5-medium", "gpt-oss-120b-medium"];

/** 제공자 전환은 서버가 이전 세션을 닫고 새 세션에 인계한다. */
function MemberConfig({ m }: { m: Member }) {
  const settings = useBootstrap()?.settings;
  const codex = m.cli === "codex";
  const rank = (codex ? settings?.codexRanks : settings?.ranks)?.[memberRank(m.kind)];
  const context = useWriteContext();
  const acceptedSnapshotVersion = useStore(state => state.acceptedSnapshotVersion);
  const diagnostics = useRuntime();
  const { busy, error, run, setError } = useAction();
  const [modelDraft, setModelDraft] = useState<{ value: string; review: WriteReview } | null>(null);
  const [codexModels, setCodexModels] = useState<ModelList | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [codexDraft, setCodexDraft] = useState<{ model: string; effort: string; speed: CodexSpeed; review: WriteReview } | null>(null);
  useEffect(() => {
    if (!codex) return;
    const controller = new AbortController();
    setCodexModels(null);
    setCatalogError(null);
    void api.models(controller.signal).then(result => {
      if (!controller.signal.aborted) setCodexModels(result.codex);
    }, error => {
      if (!controller.signal.aborted) setCatalogError(`모델 목록을 불러오지 못했습니다. ${errorText(error)}`);
    });
    return () => controller.abort();
  }, [codex, m.id]);
  const [conflict, setConflict] = useState<{ patch: PatchMemberReq; review: WriteReview; snapshotVersion: number; ready?: boolean } | null>(null);
  const model = modelDraft?.value ?? m.modelOverride ?? "";
  const capture = () => captureWriteReview(context, { kind: "member", projectId: m.projectId, id: m.id });
  const save = (patch: PatchMemberReq, reviewed = capture()) => run("config", async () => {
    try {
      const member = await executeReviewedWrite(reviewed, readWriteContext(),
        revision => api.patchMemberV2(m.id, patch, Number(revision)).then(result => result.member),
        () => api.patchMember(m.id, patch));
      if (!reviewStillCurrent(reviewed, readWriteContext())) return;
      applyLocal({ type: "member", member });
      if (codex || patch.modelOverride !== undefined || patch.cli !== undefined) {
        setModelDraft(null);
        setCodexDraft(null);
      }
      setConflict(null);
      await refresh();
    } catch (e) {
      if (e instanceof ReviewRequiredError || e instanceof ApiError && (e.status === 409 || e.status === 0)) {
        setConflict({ patch, review: reviewed, snapshotVersion: getState().acceptedSnapshotVersion });
        void refresh();
      }
      throw e;
    }
  });
  const changing = m.status === "working" || m.status === "blocked" || m.queuedCount > 0;
  const legacy = !!m.backend && m.backend !== "core";
  const blocked = runtimeBlock(diagnostics.runtime);
  const agy = m.cli === "antigravity";
  // Antigravity 는 직급 기본값이 없고 effort 가 모델 이름에 들어 있다.
  const base = (v: string | null | undefined) => agy ? "Antigravity 기본값" : `직급 기본값${v ? ` (${v})` : ""}`;
  const savedCodex = { model: m.modelOverride ?? "", effort: m.effortOverride ?? "", speed: m.codexSpeed ?? "standard" as CodexSpeed };
  const draft = codexDraft ?? savedCodex;
  const options = codexModels?.models ?? [];
  const selected = options.find(option => option.value === (draft.model || rank?.model));
  const efforts: readonly string[] = selected?.efforts.length ? selected.efforts : CODEX_EFFORTS;
  const canUseFast = selected?.supportsFast === true;
  const codexBusy = busy !== null || !!conflict || legacy || !codexModels;
  const codexPatch: PatchMemberReq = {
    ...(draft.model !== savedCodex.model ? { modelOverride: draft.model || null } : {}),
    ...(draft.effort !== savedCodex.effort ? { effortOverride: draft.effort || null } : {}),
    ...(draft.speed !== savedCodex.speed ? { codexSpeed: draft.speed } : {}),
  };
  const codexChanged = Object.keys(codexPatch).length > 0;
  const editCodex = (change: Partial<typeof savedCodex>) => setCodexDraft(previous => ({ ...savedCodex, ...previous, ...change, review: previous?.review ?? capture() }));
  const chooseCodexModel = (value: string) => {
    const option = options.find(candidate => candidate.value === (value || rank?.model));
    const supported: readonly string[] = option?.efforts.length ? option.efforts : CODEX_EFFORTS;
    editCodex({ model: value, effort: supported.includes(draft.effort) ? draft.effort : "", speed: option?.supportsFast ? draft.speed : "standard" });
  };
  const speedLabel = (speed: CodexSpeed) => speed === "fast" ? "Fast" : "Standard";
  const codexSummary = (value: typeof savedCodex) => `모델 ${value.model || base(rank?.model)} · effort ${value.effort || base(rank?.effort)} · ${speedLabel(value.speed)}`;
  return (
    <div className="tm-config">
      <p className="tm-label">AI CLI · 모델 · effort</p>
      <label className="field">
        <span className="field__label">AI CLI</span>
        <select className="input tm-select" aria-label="직원 AI CLI" disabled={busy !== null || !!conflict || !!changing || legacy || !!blocked} value={m.cli ?? "claude"} onChange={(e) => void save({ cli: e.target.value as CliProvider })}>
          {PROVIDERS.map((cli) => <option key={cli} value={cli} disabled={!!runtimeBlock(diagnostics.runtime, cli)}>{providerName(cli)}{diagnostics.runtime && !diagnostics.runtime.providers[cli]?.installed ? " · 설치 필요" : ""}</option>)}
        </select>
      </label>
      <p className="tm-note tm-note--left">{legacy ? "이전 실행기의 세션은 여기서 CLI를 전환할 수 없습니다." : changing ? "일이나 전달 대기가 끝나면 CLI를 바꿀 수 있습니다." : blocked ?? "CLI를 바꾸면 이전 세션을 닫고 현재 일과 상황을 새 세션에 인계합니다."}</p>
      {codex ? <>
        <div className="tm-config__row">
          <label className="field"><span className="field__label">모델</span><select className="input tm-select" aria-label="모델" disabled={codexBusy} value={draft.model} onChange={e => chooseCodexModel(e.target.value)}>
            <option value="">{base(rank?.model)}</option>
            {draft.model && !options.some(option => option.value === draft.model) ? <option value={draft.model} disabled>{draft.model} · 목록에 없음</option> : null}
            {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></label>
          <label className="field"><span className="field__label">effort</span><select className="input tm-select" aria-label="effort" disabled={codexBusy} value={draft.effort} onChange={e => editCodex({ effort: e.target.value })}>
            <option value="">{rank?.effort && efforts.includes(rank.effort) ? base(rank.effort) : "모델 기본값"}</option>
            {draft.effort && !efforts.includes(draft.effort) ? <option value={draft.effort} disabled>{draft.effort} · 이 모델에서 지원하지 않음</option> : null}
            {efforts.map(effort => <option key={effort} value={effort}>{effort === "max" ? "Max" : effort}</option>)}
          </select></label>
        </div>
        <label className="field"><span className="field__label">속도</span><select className="input tm-select" aria-label="속도" disabled={codexBusy} value={draft.speed} onChange={e => editCodex({ speed: e.target.value as CodexSpeed })}>
          <option value="standard">Standard</option>
          <option value="fast" disabled={!canUseFast}>Fast</option>
        </select></label>
        <GlassButton variant="glass" size="m" disabled={codexBusy || !codexChanged || (draft.speed === "fast" && !canUseFast) || ((m.status === "working" || m.status === "blocked") && !!m.paneId)} onClick={() => void save(codexPatch, codexDraft?.review ?? capture())}>{busy ? "저장하는 중" : "설정 저장"}</GlassButton>
        {codexDraft ? <GlassButton variant="ghost" size="m" disabled={busy !== null} onClick={() => { setCodexDraft(null); setConflict(null); setError(null); }}>편집 되돌리기</GlassButton> : null}
        {catalogError ? <ErrorLine>{catalogError}</ErrorLine> : null}
        {m.appliedCodexSpeed && m.appliedCodexSpeed !== savedCodex.speed ? <p className="tm-note tm-note--left">현재 세션 속도는 {speedLabel(m.appliedCodexSpeed)}입니다.</p> : null}
        {(m.status === "working" || m.status === "blocked") && codexChanged ? <p className="tm-note tm-note--left">현재 턴이 끝나면 설정을 저장할 수 있습니다.</p> : null}
      </> : <>
      <div className="tm-config__row">
        <label className="field"><span className="field__label">모델</span><input className="input t-code" aria-label="모델" disabled={busy !== null || legacy} value={model} onChange={(e) => {
          const value = e.target.value;
          setModelDraft(current => ({ value, review: current?.review ?? capture() }));
        }} placeholder={base(rank?.model)} list={`models-${m.id}`} autoCapitalize="off" autoCorrect="off" spellCheck={false} /><datalist id={`models-${m.id}`}>{(agy ? ANTIGRAVITY_MODELS : MODELS).map((x) => <option key={x} value={x} />)}</datalist></label>
        <label className="field"><span className="field__label">effort</span><select className="input tm-select" aria-label="effort" disabled={busy !== null || !!conflict || legacy || agy} value={m.effortOverride ?? ""} onChange={(e) => void save({ effortOverride: (e.target.value || null) as Effort | null })}>
          <option value="">{agy ? "모델 이름에 포함" : base(rank?.effort)}</option>
          {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
        </select></label>
      </div>
      <GlassButton variant="glass" size="m" disabled={busy !== null || !!conflict || legacy || (model.trim() || null) === m.modelOverride} onClick={() => void save({ modelOverride: model.trim() || null }, modelDraft?.review ?? capture())}>{busy ? "저장하는 중" : "모델 저장"}</GlassButton>
      </>}
      {conflict ? <div role="status">
        <p className="tm-note tm-note--left">입력한 값은 남겨 두었습니다. 현재 설정: {providerName(m.cli ?? "claude")} · {codex ? codexSummary(savedCodex) : `모델 ${m.modelOverride ?? "직급 기본값"} · effort ${m.effortOverride ?? "직급 기본값"}`}</p>
        <p className="tm-note tm-note--left">저장하려던 값: {conflict.patch.cli ? `CLI ${providerName(conflict.patch.cli)}` : codex ? codexSummary({ model: conflict.patch.modelOverride === undefined ? savedCodex.model : conflict.patch.modelOverride ?? "", effort: conflict.patch.effortOverride === undefined ? savedCodex.effort : conflict.patch.effortOverride ?? "", speed: conflict.patch.codexSpeed ?? savedCodex.speed }) : conflict.patch.effortOverride !== undefined ? `effort ${conflict.patch.effortOverride ?? "직급 기본값"}` : `모델 ${model.trim() || "직급 기본값"}`}</p>
        {conflict.ready ? (
          <GlassButton variant="glass" size="m" disabled={busy !== null} onClick={() => void save(!codex && conflict.patch.modelOverride !== undefined ? { modelOverride: model.trim() || null } : conflict.patch, conflict.review)}>검토한 변경 저장</GlassButton>
        ) : (
          <GlassButton variant="glass" size="m" disabled={busy !== null || acceptedSnapshotVersion === conflict.snapshotVersion || capture().mode === "unavailable"} onClick={() => {
            const nextReview = capture();
            setModelDraft(current => current ? { ...current, review: nextReview } : current);
            setCodexDraft(current => current ? { ...current, review: nextReview } : current);
            setConflict({ ...conflict, review: nextReview, ready: true });
            setError(null);
          }}>현재 값 확인했습니다</GlassButton>
        )}
      </div> : null}
      {modelDraft ? <GlassButton variant="ghost" size="m" disabled={busy !== null} onClick={() => { setModelDraft(null); setConflict(null); setError(null); }}>모델 입력 되돌리기</GlassButton> : null}
      {!codex ? <p className="tm-note tm-note--left">모델·effort 변경은 세션을 잠재운 뒤 다시 열 때 적용됩니다. 빈 모델은 직급 기본값을 씁니다.</p> : null}
      <ErrorLine>{error}</ErrorLine>
    </div>
  );
}

// ---- 전달 알림 ----

const NOTICE_POLL_MS = 10_000;
const NOTICE_PHASE: Record<DeliveryNoticeItem["phase"], string> = { none: "전달 대기", checking: "전달 확인 중", waiting: "확인 기다리는 중", retry_wait: "다시 보낼 차례 기다리는 중", needs_owner: "대표 확인 필요" };
const NOTICE_KIND: Record<DeliveryNoticeItem["kind"], string> = { user_message: "대표 메시지", answer: "결재 답변", todo_done: "할 일 완료 알림", instruction: "업무 지시", report: "보고 전달", system: "시스템 지시", compact: "문맥 정리" };

/** 이 직원에게 아직 닿지 않은 전달과 '다시 확인'. 앱의 전달 알림 패널과 같은 서버 API·검사를 쓴다.
 * 웹은 '다시 확인'만 내놓는다(중복 위험 재전송·중지는 앱/서버 정책 그대로 두고 여기서는 열지 않는다). */
function DeliveryNotices({ m, onCount }: { m: Member; onCount?: (count: number) => void }) {
  const [page, setPage] = useState<DeliveryNoticePage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 응답을 못 받은 요청은 같은 operationId 로 다시 보낸다(서버 멱등). 결과를 받으면 지운다.
  const ops = useRef(new Map<string, { op: string; version: number }>());
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setPage(await api.deliveryNotices(m.id, signal));
      setLoadError(null);
    } catch (e) {
      if (!signal?.aborted) setLoadError(errorText(e));
    }
  }, [m.id]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(ac.signal); }, NOTICE_POLL_MS);
    return () => { ac.abort(); clearInterval(timer); };
  }, [load]);

  const recheck = async (item: DeliveryNoticeItem) => {
    const id = item.deliveryId;
    if (!id || busy) return;
    const prev = ops.current.get(id);
    const tracked = prev && prev.version === item.version ? prev : { op: newId(), version: item.version };
    ops.current.set(id, tracked);
    setBusy(id); setActError(null); setDone(null);
    try {
      await api.recoverDelivery(id, { operationId: tracked.op, expectedVersion: tracked.version, action: "recheck" });
      ops.current.delete(id);
      setDone(`${NOTICE_KIND[item.kind]}(${id})을 다시 확인하도록 요청했습니다. 조건이 맞으면 같은 내용 그대로 다시 보냅니다.`);
    } catch (e) {
      // 서버가 답한 거절(상태가 바뀜 등)은 결과가 확정됐으니 새로 읽고 새 요청으로 다시 누를 수 있게 한다. 연결 오류는 같은 id 로 다시 보낸다.
      if (e instanceof ApiError && e.status !== 0) ops.current.delete(id);
      setActError(errorText(e));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const items = page?.items ?? [];
  useEffect(() => onCount?.(items.length), [items.length, onCount]);
  if (!items.length && !loadError) return null;
  return (
    <section className="tm-delivery" aria-label="전달 알림">
      <p className="tm-label">전달 알림 {items.length ? <span className="tm-delivery__count">{items.length}건</span> : null}</p>
      {loadError ? <p className="tm-error" role="alert">전달 알림을 읽지 못했습니다: {loadError}</p> : null}
      <ul className="tm-delivery__list">
        {items.map((item) => (
          <li key={item.id} className="tm-delivery__item" data-phase={item.phase} data-delivery-id={item.deliveryId ?? undefined}>
            <div className="tm-delivery__head">
              <Badge>{NOTICE_PHASE[item.phase]}</Badge>
              <span className="tm-delivery__kind">{NOTICE_KIND[item.kind]}</span>
              <Time iso={item.createdAt} className="tm-delivery__time" />
            </div>
            {/* 메시지·결재가 없는 지시는 서버가 종류 이름만 준다. 같은 말을 두 번 보이지 않는다. */}
            {item.preview && item.preview !== NOTICE_KIND[item.kind] ? <blockquote className="tm-delivery__preview">{item.preview}</blockquote> : null}
            <p className="tm-note tm-note--left">{item.note}</p>
            {item.deliveryId ? <p className="tm-delivery__id">전달 ID <code>{item.deliveryId}</code></p> : null}
            {item.deliveryId && item.version > 0 && item.allowedActions.includes("recheck") ? (
              <div className="tm-actions">
                <GlassButton variant="glass" size="m" disabled={busy !== null} onClick={() => void recheck(item)}>
                  {busy === item.deliveryId ? "요청하는 중" : "다시 확인"}
                </GlassButton>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {done ? <p className="tm-note tm-note--left" role="status">{done}</p> : null}
      <ErrorLine>{actError}</ErrorLine>
    </section>
  );
}

function MemberDetailBody({ m, project, compactAt, openAsks, section, onSection }: { m: Member; project: Project; compactAt: number; openAsks: number; section: MemberSection; onSection: (section: MemberSection) => void }) {
  const [deliveryCount, setDeliveryCount] = useState(0);
  const hasScreen = m.backend === "core" && !!m.paneId && m.status !== "asleep" && m.status !== "offline";
  const [pane, setPane] = useState<"activity" | "screen" | null>(null);
  const shownPane = hasScreen ? (pane ?? (m.status === "blocked" ? "screen" : "activity")) : "activity";
  const { busy, error, run } = useAction();
  const [notice, setNotice] = useState<string | null>(null);
  const closeConfirm = useConfirmPress();
  const forceConfirm = useConfirmPress();
  // 대기열·열린 결재로 거부되면 대표만 무릅쓸 수 있다.
  const [sleepRefused, setSleepRefused] = useState<string | null>(null);
  const manual = m.origin === "manual";
  const tasks = useProject()?.tasks ?? [];
  const asleep = m.status === "asleep" || m.status === "offline";
  const legacy = !!m.backend && m.backend !== "core";

  const memberAct = (key: string, call: (id: string) => Promise<Member>, done?: string) =>
    run(key, async () => {
      setNotice(null);
      applyLocal({ type: "member", member: await call(m.id) });
      if (done) setNotice(done);
    });

  return (
    <div className="tm tm-detail">
      <div className="tm-detail__top">
        <StaffStatus m={m} label />
        <Badge>{providerName(m.cli ?? "claude")}</Badge>
        {m.role ? <span className="tm-detail__role">{m.role}</span> : null}
        <Subagents n={m.subagents} />
        <Time iso={m.updatedAt} relative className="tm-detail__time" />
      </div>
      {/* 승인 창을 읽을 수 있으면 여기서 승인·거절한다. 못 읽으면(폴더 신뢰 창 등) 화면을 보고 터미널에서 푼다. */}
      {m.status === "blocked" ? <ApprovalPanel member={m} boxed fallback={<p className="tm-hint">승인 창 앞에서 멈췄습니다. 화면을 보고 터미널에서 승인하거나 거절하세요.</p>} /> : null}
      {m.status === "blocked" && m.backend === "core" && m.paneId ? <CopyCommand m={m} /> : null}
      {deliveryCount > 0 && section !== "runtime" ? <button type="button" className="tm-detail-alert" onClick={() => onSection("runtime")}>전달 알림 {deliveryCount}건 →</button> : null}
      {openAsks > 0 && section !== "summary" ? <a className="tm-detail-alert" href={routeHash({projectId: m.projectId, tab: "inbox"})}>결재 대기 {openAsks}건 →</a> : null}
      <div hidden={section !== "summary"}>
      <MemberFacts m={m} compactAt={compactAt} openAsks={openAsks} />
      {m.lastError ? <p className="tm-error">{m.lastError}</p> : null}
      <NoTools m={m} />
      {m.kind !== "worker" && project.now ? <section className="tm-detail-report"><h3>팀 상황</h3><Markdown text={project.now}/></section> : null}
      </div>
      <div hidden={section !== "runtime"}>

      {manual ? (
        <>
          <p className="tm-note tm-note--left">직접 띄운 세션입니다. 압축하거나 재울 수 없고, 보낸 말은 그 세션이 wait 를 부를 때 전달됩니다. 도구 호출이 오래 없으면 안 보임으로 표시합니다.</p>
          <div className="tm-actions">
            <GlassButton
              variant="glass"
              size="m"
              disabled={busy !== null || legacy}
              onClick={() =>
                closeConfirm.press(() => {
                  void run("close", async () => {
                    await api.closeMember(m.id);
                    applyLocal({ type: "member_removed", projectId: m.projectId, memberId: m.id });
                  });
                })
              }
            >
              {busy === "close" ? "빼는 중" : closeConfirm.armed ? "한 번 더 누르면 뺍니다" : "명부에서 빼기"}
            </GlassButton>
          </div>
        </>
      ) : (
        <div className="tm-actions">
          {asleep || memberIssueLabel(m) ? (
            project.runnerEnabled ? (
              <GlassButton variant="glass" size="m" disabled={busy !== null || legacy} onClick={() => memberAct("resume", api.resume)}>
                {busy === "resume" ? "여는 중" : providerIssueKind(m.executionIssue?.detail ?? m.lastError) ? "다시 확인" : memberIssueLabel(m) ? "다시 시도" : "깨우기"}
              </GlassButton>
            ) : (
              <p className="tm-note tm-note--left">실행이 꺼져 있어 깨울 수 없습니다. 팀 화면에서 총괄을 시작하세요.</p>
            )
          ) : (
            <>
              {canStop(m) ? (
                <GlassButton
                  variant="glass"
                  size="m"
                  disabled={busy !== null || legacy}
                  title={`멈출 것: ${runLabel(m, tasks)}`}
                  onClick={() =>
                    run("interrupt", async () => {
                      setNotice(null);
                      const r = await api.stop(m.id, stopExpectation(m));
                      applyLocal({ type: "member", member: r.member });
                      setNotice(stopNotice(r, tasks, false));
                    })
                  }
                >
                  {busy === "interrupt" ? "멈추는 중" : "중단"}
                </GlassButton>
              ) : null}
              <GlassButton
                variant="glass"
                size="m"
                disabled={busy !== null || !m.sessionId || m.backend === "core" || legacy}
                onClick={() => memberAct("compact", api.compact, m.status === "working" ? "압축을 예약했습니다. 지금 턴이 끝나면 실행합니다." : "압축을 요청했습니다.")}
              >
                {busy === "compact" ? "요청하는 중" : "압축"}
              </GlassButton>
              <GlassButton
                variant="glass"
                size="m"
                disabled={busy !== null || legacy}
                onClick={() =>
                  run("sleep", async () => {
                    setNotice(null);
                    setSleepRefused(null);
                    try {
                      applyLocal({ type: "member", member: await api.sleep(m.id) });
                    } catch (e) {
                      // 칸에 선택 창(입력칸을 못 찾음)이나 승인 창이 떠 있으면 무릅쓸 수 없다. 대표가 풀어야 한다. 입력칸에 남은 글은 서버가 지운다.
                      if (e instanceof ApiError && e.status === 409 && !/입력칸|승인 창/.test(e.message)) setSleepRefused(e.message);
                      else throw e;
                    }
                  })
                }
              >
                {busy === "sleep" ? "재우는 중" : "잠재우기"}
              </GlassButton>
              {sleepRefused ? (
                <GlassButton
                  variant="glass"
                  size="m"
                  disabled={busy !== null || legacy}
                  onClick={() =>
                    forceConfirm.press(() => {
                      void run("sleep", async () => {
                        applyLocal({ type: "member", member: await api.sleep(m.id, true) });
                        setSleepRefused(null);
                      });
                    })
                  }
                >
                  {forceConfirm.armed ? "한 번 더 누르면 재웁니다" : "그래도 재우기"}
                </GlassButton>
              ) : null}
            </>
          )}
        </div>
      )}
      {!manual ? <div className="tm-config">
        <GlassButton variant="glass" size="m" disabled={busy !== null || m.status === "working" || m.status === "blocked"} onClick={() => memberAct("fresh", api.freshSession, "이전 세션의 기록을 보관하고 새 세션에 현재 일을 인계했습니다.")}>
          {busy === "fresh" ? "새 세션을 준비하는 중" : "새 세션으로 이어가기"}
        </GlassButton>
        <p className="tm-note tm-note--left">이전 제공자의 세션을 다시 쓰지 않고 역할·현재 일·다음을 새 세션에 인계합니다. 일하거나 승인 창 앞이면 끝난 뒤 시작하세요. 이전 실행기의 터미널은 직접 종료할 때까지 그대로 둡니다.</p>
      </div> : null}
      {m.backend === "core" ? <p className="tm-note tm-note--left">자동 압축은 지원하지 않습니다. 연결된 터미널에서 CLI의 /compact 명령을 사용하세요.</p> : null}
      <ErrorLine>{error ?? (sleepRefused && !asleep ? `${sleepRefused}. 그래도 재우면 돌던 턴이 끊기고 대기열은 깨울 때까지 멈춥니다.` : null)}</ErrorLine>
      {notice ? (
        <p className="tm-note tm-note--left" role="status">
          {notice}
        </p>
      ) : null}

      <DeliveryNotices m={m} onCount={setDeliveryCount} />

      {manual ? null : <MemberConfig m={m} />}
      {(m.sessionId || (m.backend === "core" && m.paneId)) && m.status !== "blocked" ? <CopyCommand m={m} /> : null}

      </div>
      <div className="tm-panes" hidden={section !== "activity"}>
        {hasScreen ? (
          <div className="tm-chips">
            <button type="button" className="tm-chip" aria-pressed={shownPane === "activity"} onClick={() => setPane("activity")}>
              활동
            </button>
            <button type="button" className="tm-chip" aria-pressed={shownPane === "screen"} onClick={() => setPane("screen")}>
              화면
            </button>
          </div>
        ) : (
          <p className="tm-label">활동</p>
        )}
        {shownPane === "screen" ? <><ScreenPane memberId={m.id} />{m.backend === "core" ? <TerminalInput member={m} /> : null}</> : <ActivityList memberId={m.id} />}
      </div>
    </div>
  );
}

/** Direct inputs share durable submission handling with the bottom composer, with
 * independent per-member drafts and the real project ID retained in every request. */
function DirectInput({ m }: { m: Member }) {
  const gate = useGate();
  const manager = memberSubmissions(m);
  const { draft, attempts } = useSubmissionDraft(m.projectId, manager);
  const [sentId, setSentId] = useState<string | null>(null);
  const sent = useProject()?.messages.find((message) => message.id === sentId) ?? null;
  const asleep = m.status === "asleep" || m.status === "offline";
  const submit = () => {
    const text = draft.text.trim();
    if (!text) return;
    // A conductor uses the project path; workers retain their exact member ID.
    const result = manager.submit(m.projectId, draft, { text, targetMemberId: m.kind === "worker" ? m.id : null, attachmentIds: [] }, { targetName: m.name });
    const staged = manager.snapshot(m.projectId).attempts.at(-1);
    if (staged && !manager.snapshot(m.projectId).draft.error) setSentId(staged.id);
    void result;
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isComposing(e) && enterSends(e)) { e.preventDefault(); submit(); }
  };
  const placeholder = asleep ? `${m.name}에게 직접 지시 (보내면 깨워서 전달합니다)` : `${m.name}에게 직접 지시`;
  if (!gate.ok) return <ConnectGate className="tm-send" />;
  return (
    <form className="tm tm-send" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {draft.error ? <p className="tm-send__state" data-state="failed" role="alert">{draft.error}</p> : null}
      {attempts.map((attempt) => (
        <div key={attempt.id} className="tm-send__state" data-state={attempt.status === "checking" ? "queued" : "failed"} role="status">
          <span>{attempt.payload.text.slice(0, 60)}{attempt.payload.text.length > 60 ? "…" : ""}</span>
          <p>{attempt.status === "checking" ? "전송 결과 확인 중…" : attempt.error ?? "전송 결과를 확인하지 못했습니다"}</p>
          <GlassButton variant="ghost" size="s" disabled={attempt.status === "checking"} onClick={() => void manager.reconcile(m.projectId)}>다시 확인</GlassButton>
          <GlassButton variant="ghost" size="s" disabled={attempt.status === "checking"} onClick={() => void manager.retry(m.projectId, attempt.id)}>같은 내용 재시도</GlassButton>
        </div>
      ))}
      {!attempts.length && sent?.delivery ? <p className="tm-send__state" data-state={sent.delivery} role="status">보낸 지시: {DELIVERY_LABEL[sent.delivery]}{sent.deliveryNote ? ` (${sent.deliveryNote})` : ""}</p> : null}
      <div className="tm-send__row">
        <textarea className="input tm-send__input" rows={1} value={draft.text} placeholder={placeholder} aria-label={placeholder} onChange={(e) => manager.patchDraft(m.projectId, (d) => ({ ...d, text: e.target.value, error: null }))} onKeyDown={onKey} />
        <GlassButton variant="primary" size="m" type="submit" disabled={!draft.text.trim()}>보내기</GlassButton>
      </div>
    </form>
  );
}

type MemberSection = "summary" | "tasks" | "activity" | "runtime";
type MemberView = {
  memberId: string;
  section: MemberSection;
  tab: TeamTaskTab;
  expanded: string | null;
};
function MemberInspector({
  m,
  state,
  compactAt,
  initial,
  onFocus,
  onMember,
  onClose,
}: {
  m: Member;
  state: ProjectState;
  compactAt: number;
  initial?: MemberView;
  onFocus: (id: string, view: MemberView) => void;
  onMember: (id: string) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<MemberView>(
    initial ?? {
      memberId: m.id,
      section: "summary",
      tab: "all",
      expanded: null,
    },
  );
  useEffect(() => {
    if (initial) setView(initial);
  }, [initial]);
  const nodes = useWorkflowNodes(state),
    own = nodes
      .filter((n) => n.memberId === m.id)
      .sort((a, b) => a.order - b.order);
  const online = useStore((s) => s.connection === "online");
  const openAsks = state.decisions.filter(
    (d) => d.status === "open" && d.memberId === m.id,
  ).length;
  const sections: [MemberSection, string][] = [
    ["summary", "요약"],
    ["tasks", "업무"],
    ["activity", "활동"],
    ["runtime", "실행·설정"],
  ];
  return (
    <>
      <nav className="tm-detail-tabs" aria-label="직원 상세 탭">
        <Glass className="team-segments" level="regular">
          {sections.map(([section, label]) => (
            <GlassButton
              key={section}
              size="s"
              variant="ghost"
              ariaPressed={view.section === section}
              onClick={() => setView({ ...view, section })}
            >
              {label}
              {section === "tasks" && state.workflow ? (
                <span className="wf-count">{own.length}</span>
              ) : null}
            </GlassButton>
          ))}
        </Glass>
      </nav>
      {!state.workflow && ["summary", "tasks"].includes(view.section) ? <p className="wf-empty" role="status">업무 흐름을 확인할 수 없습니다.</p> : null}
      {view.section === "summary" && state.workflow ? (
        <div className="tm-detail-metrics">
          {(
            [
              ["now", "지금"],
              ["next", "다음·대기"],
              ["blocked", "막힘"],
              ["done", "완료"],
            ] as const
          ).map(([tab, label]) => (
            <button
              type="button"
              key={tab}
              onClick={() =>
                setView({ ...view, section: "tasks", tab, expanded: null })
              }
            >
              <span>{label}</span>
              <b>{teamTaskScope(own, tab).length}</b>
            </button>
          ))}
        </div>
      ) : null}
      <MemberDetailBody
        m={m}
        project={state.project}
        compactAt={compactAt}
        openAsks={openAsks}
        section={view.section}
        onSection={(section) => setView({ ...view, section })}
      />
      {view.section === "tasks" ? (
        <TeamTaskList
          state={{
            ...state,
            workflow: { nodes, edges: state.workflow?.edges ?? [] },
          }}
          nodes={own}
          online={online}
          tab={view.tab}
          onTab={(tab) => setView({ ...view, tab, expanded: null })}
          expanded={view.expanded}
          onExpand={(expanded) => setView({ ...view, expanded })}
          onFocus={(id) => onFocus(id, view)}
          onMember={onMember}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}
function MemberDetail({
  memberId,
  compactAt,
  view,
  onFocus,
  onMember,
  onClose,
}: {
  memberId: string | null;
  compactAt: number;
  view: MemberView | null;
  onFocus: (taskId: string, view: MemberView) => void;
  onMember: (id: string) => void;
  onClose: () => void;
}) {
  const desktop = useMediaQuery(MQ_DESKTOP),
    project = useProject(),
    member = findMember(project, memberId);
  const Overlay = desktop ? Drawer : Sheet;
  const close = onClose;
  useEffect(() => {
    if (memberId && project && !member)
      navigate({ sub: null }, { replace: true });
  }, [memberId, project, member]);
  return (
    <Overlay
      open={!!member}
      onClose={close}
      title={
        member
          ? `${member.name}${member.kind === "conductor" ? " · 총괄" : ""}`
          : undefined
      }
      footer={
        member && project ? (
          <DirectInput key={member.id} m={member} />
        ) : undefined
      }
    >
      {member && project ? (
        <MemberInspector
          key={member.id}
          m={member}
          state={project}
          compactAt={compactAt}
          initial={view?.memberId === member.id ? view : undefined}
          onFocus={onFocus}
          onMember={onMember}
          onClose={close}
        />
      ) : null}
    </Overlay>
  );
}

// ---- 화면 ----

/** '3분 전'이 멈춰 보이지 않게 이벤트가 없어도 가끔 다시 그린다 */
function useClockTick() {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, []);
}

export default function Team() {
  const state = useProject();
  return state ? <TeamContent key={state.project.id} state={state} /> : null;
}
function TeamContent({ state }: { state: ProjectState }) {
  const route = useRoute(),
    bootstrap = useBootstrap(),
    compactAt = bootstrap?.settings.compactAtPct ?? 70;
  const [view, setView] = useState<MemberView | null>(null),
    [focus, setFocus] = useState<{
      taskId: string;
      at: number;
      onReturn?: () => void;
    } | null>(null),
    [menu, setMenu] = useState<
      "report" | "memory" | "records" | "create" | null
    >(null);
  const Overlay = useMediaQuery(MQ_DESKTOP) ? Drawer : Sheet;
  useClockTick();
  const { project, members, work } = state;
  const memberOrigin = useRef<HTMLElement | null>(null);
  const closeMember = () => {
    navigate({ sub: null });
    requestAnimationFrame(() => {
      const origin = memberOrigin.current;
      if (origin?.isConnected) origin.focus({ preventScroll: true });
      else if (view)
        document
          .querySelector<HTMLElement>(
            `[data-member-id="${CSS.escape(view.memberId)}"] .to-person`,
          )
          ?.focus({ preventScroll: true });
    });
  };
  const openMember = (
    memberId: string,
    tab?: TeamTaskTab,
    expanded: string | null = null,
  ) => {
    memberOrigin.current = document.activeElement as HTMLElement;
    setView({
      memberId,
      section: tab ? "tasks" : "summary",
      tab: tab ?? "all",
      expanded,
    });
    navigate({ sub: memberId });
  };
  const openFocus = (taskId: string, snapshot: MemberView) => {
    navigate({ sub: null });
    setFocus({
      taskId,
      at: Date.now(),
      onReturn: () => {
        setView(snapshot);
        navigate({ sub: snapshot.memberId });
      },
    });
  };
  const actionMenu = (
    <details className="to-menu">
      <summary aria-label="팀 메뉴">⋯</summary>
      <div>
        {(
          [
            ["report", "팀 상황"],
            ["memory", "개발 기억"],
            ["records", "진행판 기록"],
            ...(!project.isHq ? [["create", "직원 추가"]] : []),
          ] as ["report" | "memory" | "records" | "create", string][]
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            onClick={(e) => {
              e.currentTarget.closest("details")?.removeAttribute("open");
              setMenu(key);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </details>
  );
  return (
    <div className="tm">
      {!project.runnerEnabled || !members.length ? (
        <StartPanel project={project} hasMembers={members.length > 0} />
      ) : null}
      <WorkFlow
        state={state}
        overview
        onMember={openMember}
        onNodeSelect={(node) => {
          if (node.memberId && members.some((m) => m.id === node.memberId)) {
            openMember(node.memberId, "all", node.id);
            return true;
          }
          return false;
        }}
        focusRequest={focus}
        headerActions={actionMenu}
        onRecords={() => setMenu("records")}
      />
      <MemberDetail
        memberId={route.sub}
        compactAt={compactAt}
        view={view}
        onClose={closeMember}
        onFocus={openFocus}
        onMember={(id) => openMember(id)}
      />
      <Overlay
        open={menu !== null && menu !== "create"}
        title={
          menu === "report"
            ? "팀 상황"
            : menu === "memory"
              ? "개발 기억"
              : "진행판 기록"
        }
        onClose={() => setMenu(null)}
      >
        {menu === "report" ? (
          project.now ? (
            <>
              <Time iso={project.nowAt} />
              <Markdown text={project.now} />
            </>
          ) : (
            <p className="wf-empty">등록된 팀 상황이 없습니다.</p>
          )
        ) : null}
        {menu === "memory" ? (
          <dl className="tm-facts">
            <MemoryRow project={project} />
          </dl>
        ) : null}
        {menu === "records" ? (
          <>
            <WorkList work={work} tasks={state.tasks ?? []} />
            <section className="to-records">
              <h3>업무 흐름 밖의 기록</h3>
              {(state.tasks ?? [])
                .filter(
                  (t) => !state.workflow?.nodes.some((n) => n.taskId === t.id),
                )
                .map((t) => (
                  <article key={t.id}>
                    <a
                      href={routeHash({ projectId: project.id, tab: "thread" })}
                      onClick={() => {
                        chooseTask(project.id, { id: t.id });
                        setMenu(null);
                      }}
                    >
                      {t.title}
                    </a>
                    <Time iso={t.updatedAt} />
                    {t.mergedInto ? <span>합쳐진 업무</span> : null}
                  </article>
                ))}
            </section>
          </>
        ) : null}
      </Overlay>
      {menu === "create" ? (
        <CreateMember project={project} onDismiss={() => setMenu(null)} />
      ) : null}
    </div>
  );
}
