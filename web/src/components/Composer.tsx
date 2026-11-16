// 모든 화면 아래 입력칸. Enter 전송 · Shift+Enter 줄바꿈(터치 기기는 소프트 키보드에 Shift 가 없어 Enter 가 줄바꿈, 보내기 버튼으로 전송) · 첨부(버튼·붙여넣기·드래그) · @직원 지정.
// 글·대상·첨부는 프로젝트별로 틀 밖과 localStorage 에 둔다: 프로젝트를 오가거나 틀이 다시 그려져도, 새로고침·앱 재시작 뒤에도 쓰던 글이 남아야 한다.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import type { Member, MemberStatus, StopReq, Task } from "@shared/types";
import { GlassButton, Glass } from "../glass";
import { api, errorText, fileUrl, getCredentialGeneration } from "../lib/api";
import ConnectGate, { isGateRejection, useGate } from "./ConnectGate";
import { getState, newId, refresh, routeHash, useProject, useRoute } from "../lib/store";
import type { Draft } from "../lib/submissions";
import { chooseTask, submissions, useSubmissionDraft } from "../lib/submission-client";
import { StatusDot } from "./ui";
import { liveTasks, taskWorkers, visibleTasks } from "../lib/tasks";
import { canStop, runLabel, stopExpectation, stopNotice } from "../lib/stop";
import "../styles/composer.css";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const NOTICE_MS = 4000;
const STOP_NOTICE_MS = 15000;

const patchDraft = (projectId: string, patch: (draft: Draft) => Draft) => submissions.patchDraft(projectId, patch);

function attachFiles(projectId: string, files: File[]): void {
  for (const file of files) {
    const name = file.name || "첨부";
    const ticket = submissions.beginUpload(projectId, { key: newId(), name });
    if (file.size > MAX_UPLOAD_BYTES) {
      submissions.finishUpload(ticket, null, "파일은 50MB 까지 올릴 수 있습니다");
      continue;
    }
    api.upload(file, name, { project: projectId, target: ticket.targetId }).then(
      (attachment) => submissions.finishUpload(ticket, attachment),
      (e) => {
        // A failed upload remains visible. Selecting the file again is required
        // because browsers cannot restore a File after a page reload.
        if (submissions.finishUpload(ticket, null, errorText(e)) && isGateRejection(e)) void refresh();
      },
    );
  }
}

/** 한글 조합을 끝내는 Enter 는 전송이 아니다. Safari 는 조합이 끝난 뒤에 keydown 을 주므로 keyCode 229 로도 본다. */
export function isComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/** 터치 기기의 소프트 키보드에는 Shift 가 없다. Enter 는 줄바꿈, 전송은 버튼이다. */
export function touchInput(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

/** 이 키가 전송인가. 어느 기기든 Cmd·Ctrl+Enter 는 전송이다. */
export function enterSends(e: KeyboardEvent): boolean {
  if (e.key !== "Enter" || e.shiftKey) return false;
  return e.metaKey || e.ctrlKey || !touchInput();
}

/** 글 길이에 맞춰 칸을 키운다. 상한은 CSS 의 max-height 가 정한다. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

interface MenuEntry {
  id: string | null; // null 이면 기본 대상(총괄·본사 AI)
  name: string;
  handle: string | null;
  role: string;
  status: MemberStatus | null;
}

/** 메뉴에서 고르지 않고 끝까지 친 첫머리 `@이름 글`. 정확히 맞는 직원이 있을 때만 대상으로 친다. */
export function leadingMention<T extends { name: string; handle: string }>(text: string, workers: T[]): { member: T; rest: string } | null {
  const m = /^@(\S+)\s+([\s\S]*\S)\s*$/.exec(text);
  if (!m) return null;
  const member = workers.find((w) => w.name === m[1] || w.handle === m[1]);
  return member ? { member, rest: m[2]! } : null;
}

function findMention(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]!.toLowerCase() } : null;
}

const useWindowFileDrag = (projectId: string, enabled: boolean): boolean => {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    setDragging(false);
    if (!enabled) return;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    // 창 어디에 놓아도 받는다. 브라우저가 파일을 여는 것은 App 이 어느 화면에서나 막는다.
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      setDragging(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      attachFiles(projectId, [...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [projectId, enabled]);
  return dragging;
};

export default function Composer() {
  const route = useRoute();
  const state = useProject();
  const projectId = route.projectId;
  const project = state?.project.id === projectId ? state : null;
  const { draft, attempts } = useSubmissionDraft(projectId);
  const gate = useGate();
  const dragging = useWindowFileDrag(projectId, gate.ok);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [chipMenu, setChipMenu] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  /** 멈춤을 보내는 중인 직원. 결과가 올 때까지 멈춤 버튼은 눌리지 않는다(서버도 겹친 요청을 한 번으로 합친다). */
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopResult, setStopResult] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  // 게이트가 열리면 칸이 새로 그려진다. 값이 그대로여도 높이를 다시 잰다.
  useAutoGrow(inputRef, gate.ok ? draft.text : "");

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (!stopResult) return;
    const t = setTimeout(() => setStopResult(null), STOP_NOTICE_MS);
    return () => clearTimeout(t);
  }, [stopResult]);

  useEffect(() => {
    setChipMenu(false);
    setNotice(null);
    setDismissedAt(null);
    setStopResult(null);
  }, [projectId]);

  useEffect(() => {
    if (!chipMenu) return;
    const outside = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setChipMenu(false);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [chipMenu]);

  const isHq = project?.project.isHq ?? projectId === "hq";
  const members = project?.members ?? [];
  const lead = members.find((m) => m.kind === "root" || m.kind === "conductor") ?? null;
  const workers = members.filter((m) => m.kind === "worker");
  const target = workers.find((m) => m.id === draft.targetId) ?? null;
  const allTasks = project?.tasks ?? [];
  const task = draft.taskId ? allTasks.find((t) => t.id === draft.taskId) ?? null : null;
  // 업무 칩은 받는 사람과 상관없이 늘 같은 목록이다(직원을 바꿔도 칩이 사라지거나 고른 업무가 풀리지 않는다). 맡은 직원은 이름으로만 보인다.
  const shownTasks = visibleTasks(liveTasks(allTasks, project?.work, task?.id ?? null), null);
  const chipWho = (t: Task): string | null => {
    const names = taskWorkers(t, workers).map((id) => workers.find((w) => w.id === id)!.name);
    return names.length ? names.join("·") : t.who.trim() || null;
  };
  const leadName = lead?.name ?? (isHq ? "본사 AI" : "총괄");
  const entries: MenuEntry[] = [
    { id: null, name: leadName, handle: null, role: "기본", status: lead?.status ?? null },
    ...workers.map((m) => ({ id: m.id, name: m.name, handle: m.handle, role: m.role, status: m.status })),
  ];

  const mention = findMention(draft.text, caret);
  const mentionOpen = mention !== null && mention.start !== dismissedAt;
  const matches = mentionOpen && !chipMenu
    ? entries.filter((e) => e.name.toLowerCase().includes(mention.query) || (e.handle ?? "").includes(mention.query))
    : entries;
  const menuOpen = chipMenu || (mentionOpen && matches.length > 0);
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));

  // 받는 사람만 바꾼다. 고른 업무는 그대로 둔다(같은 업무를 다른 직원에게 이어서 보낼 수 있다).
  const pick = (entry: MenuEntry) => {
    setChipMenu(false);
    setActive(0);
    if (mention && mentionOpen && !chipMenu) {
      const rest = draft.text.slice(mention.start + mention.query.length + 1).replace(/^ /, "");
      const text = draft.text.slice(0, mention.start) + rest;
      patchDraft(projectId, (d) => ({ ...d, text, targetId: entry.id }));
      setCaret(mention.start);
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(mention.start, mention.start));
    } else {
      patchDraft(projectId, (d) => ({ ...d, targetId: entry.id }));
    }
    inputRef.current?.focus();
  };

  // 업무만 바꾼다. '전체'로 돌아와도 받는 사람은 그대로다(대화 글의 업무 이름과 같은 규칙).
  const pickTask = (next: Task | null) => chooseTask(projectId, next);
  // 작업이 바뀌면(대화 글의 작업 표지로 골랐을 때도) 고른 칩이 가로 목록 밖에 숨지 않게 그 칩까지 민다. '전체'면 처음으로 돌린다.
  const tasksRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const strip = tasksRef.current;
    if (!strip) return;
    const on = task ? strip.querySelector<HTMLElement>('.cmp-task[aria-pressed="true"]') : null;
    if (!on) {
      strip.scrollLeft = 0;
      return;
    }
    const box = strip.getBoundingClientRect();
    const chip = on.getBoundingClientRect();
    if (chip.left < box.left) strip.scrollLeft -= box.left - chip.left + 8;
    else if (chip.right > box.right) strip.scrollLeft += chip.right - box.right + 8;
  }, [task?.id]);

  /** 메뉴가 받아 간 키면 true. 초점이 입력칸에 있든 대상 칩에 있든 같은 키로 움직인다. */
  const menuKey = (e: KeyboardEvent): boolean => {
    if (!menuOpen) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + matches.length) % matches.length);
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      const entry = matches[activeIndex];
      if (entry) pick(entry);
    } else if (e.key === "Escape") {
      setChipMenu(false);
      if (mention) setDismissedAt(mention.start);
    } else {
      return false;
    }
    e.preventDefault();
    return true;
  };

  const uploading = draft.uploads.some((u) => !u.attachment && !u.failed);
  const failedUpload = draft.uploads.some((u) => u.failed);
  const ready = draft.uploads.flatMap((u) => (u.attachment ? [u.attachment] : []));
  const text = draft.text.trim();
  const canSend = !!project && !uploading && !failedUpload && (text.length > 0 || ready.length > 0);
  // 지금 글이 갈 사람. 그 사람이 일하는 중이면 입력칸 위에 멈춤 줄을 보인다.
  const recipient: Member | null = target ?? lead;

  /** 멈춤 요청. 결과(멈춤 확인·멈출 턴 없음·실행이 바뀜·실패)를 그대로 보인다. 결과를 모르면 다시 보내지 않고 상태를 보라고 한다. */
  const stopRun = async (m: Member, req: StopReq, followUp: boolean) => {
    setStopping(m.id);
    setStopResult(null);
    try {
      const r = await api.stop(m.id, req);
      setStopResult({ text: stopNotice(r, allTasks, followUp), tone: r.outcome === "stopped" || r.outcome === "not_running" ? "ok" : "warn" });
    } catch (e) {
      setStopResult({ text: `${m.name}: 멈춤 결과를 확인하지 못했습니다(${errorText(e)}). 다시 누르기 전에 팀 화면에서 상태를 보세요.${followUp ? " 보낸 글은 대기열에 있습니다." : ""}`, tone: "warn" });
    } finally {
      setStopping(null);
    }
  };

  /** stop: '멈추고 이 글로 이어가기'. 글을 먼저 대기열에 고정(받는 사람·작업·원문)하고, 서버가 받은 뒤에만 멈춘다. */
  const send = async (opts: { stop?: boolean } = {}) => {
    if (uploading || failedUpload) {
      patchDraft(projectId, (d) => ({ ...d, error: uploading ? "첨부를 올리는 중입니다. 끝나면 보내 주세요" : "올리지 못한 첨부를 지운 뒤 보내 주세요" }));
      return;
    }
    if (!canSend) return;
    // 작업을 골랐으면 받는 사람은 그 작업의 직원으로 고정이다. 첫머리 @이름으로 바꾸지 않는다.
    const typed = target || task ? null : leadingMention(text, workers);
    const to = typed?.member ?? target;
    const body = typed?.rest ?? text;
    const session = getCredentialGeneration();
    // 누른 순간에 본 실행. 글이 늦게 닿아 그 턴이 끝났으면 서버가 새 턴을 끊지 않는다.
    const receiver = to ?? lead;
    const stopWith = opts.stop && canStop(receiver) && !stopping ? { member: receiver, req: stopExpectation(receiver) } : null;
    const result = submissions.submit(
      projectId,
      draft,
      { text: body, targetMemberId: to?.id ?? null, attachmentIds: ready.map((a) => a.id), taskId: task?.id ?? null },
      { targetName: to?.name ?? leadName, attachments: ready },
    );
    // submit persists synchronously before clearing the input. A storage failure
    // leaves the draft intact and blocks the network request.
    if (submissions.snapshot(projectId).draft.error) return;
    setCaret(0);
    setNotice(null);
    inputRef.current?.focus();
    const saved = await result;
    if (!saved || getCredentialGeneration() !== session || getState().route.projectId !== projectId) return;
    if (stopWith) await stopRun(stopWith.member, stopWith.req, true);
    else setNotice(`${to?.name ?? leadName}에게 보냈습니다${canStop(receiver) ? " · 지금 턴이 끝나면 전달됩니다" : ""}`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(e)) return;
    if (menuKey(e)) return;
    if (enterSends(e)) {
      e.preventDefault();
      void send();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    // 표 앱은 글과 그림을 함께 복사한다. 글을 막으면 표 내용이 사라진다. 파인더는 파일 이름을 글로 함께 주므로 그것만 거른다.
    const typed = e.clipboardData.getData("text/plain").trim();
    const onlyNames = typed.split(/[\r\n]+/).every((line) => files.some((f) => f.name === line.trim()));
    if (!typed || onlyNames) e.preventDefault();
    attachFiles(projectId, files);
  };

  const placeholder = task ? `'${task.title}' 작업으로 ${target?.name ?? leadName}에게` : target ? `${target.name}에게 직접 지시` : isHq ? "본사 AI에게 — 새 프로젝트 만들기 등" : "지시나 질문";
  const showThreadLink = notice !== null && route.tab !== "thread";

  if (!gate.ok) {
    const kept = draft.text.trim().length > 0 || draft.uploads.length > 0 || attempts.length > 0;
    return (
      <div ref={rootRef} className="cmp">
        <ConnectGate />
        {kept ? <p className="cmp__kept">쓰던 글은 보관했습니다</p> : null}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="cmp">
      {menuOpen && matches.length > 0 ? (
        <ul className="cmp-menu" role="listbox" id="cmp-menu" aria-label="보낼 대상">
          {matches.map((entry, i) => (
            <li
              key={entry.id ?? "lead"}
              id={`cmp-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className="cmp-menu__item"
              onMouseEnter={() => setActive(i)}
              // 눌러도 입력칸의 초점과 커서를 뺏지 않는다
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(entry)}
            >
              <span className="cmp-menu__main">
                <span className="cmp-menu__name">{entry.name}</span>
                <span className="cmp-menu__sub">{[entry.handle ? `@${entry.handle}` : null, entry.role].filter(Boolean).join(" · ")}</span>
              </span>
              {entry.status ? <StatusDot status={entry.status} label /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <Glass level="regular" tint refract={{ band: 14, scale: 34 }} radius={20} className="cmp__panel" data-drag={dragging ? "" : undefined}>
        <div className="cmp__meta">
          <button
            type="button"
            className="cmp-chip cmp-chip--target"
            data-direct={target ? "" : undefined}
            aria-label={`보낼 대상: ${target?.name ?? leadName}. 눌러서 바꾸기`}
            aria-haspopup="listbox"
            aria-expanded={chipMenu}
            aria-controls={chipMenu ? "cmp-menu" : undefined}
            aria-activedescendant={chipMenu ? `cmp-opt-${activeIndex}` : undefined}
            onClick={() => {
              setChipMenu((v) => !v);
              setActive(0);
            }}
            onKeyDown={(e) => void menuKey(e)}
          >
            <span className="cmp-chip__label">{target ? `@${target.name}` : isHq ? "본사 AI" : "총괄"}</span>
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {shownTasks.length > 0 || task ? (
            <div ref={tasksRef} className="cmp-tasks" role="group" aria-label="업무 고르기">
              <button type="button" className="cmp-task" aria-pressed={!task} onClick={() => pickTask(null)}>
                전체
              </button>
              {shownTasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="cmp-task"
                  aria-pressed={task?.id === t.id}
                  title={[t.title, t.who, t.branch, t.worktree].filter(Boolean).join(" · ")}
                  onClick={() => pickTask(task?.id === t.id ? null : t)}
                >
                  {chipWho(t) ? <span className="cmp-task__who">{chipWho(t)}</span> : null}
                  <span className="cmp-task__title">{t.title}</span>
                </button>
              ))}
            </div>
          ) : null}
          {draft.uploads.map((u) => (
            <span key={u.key} className="cmp-chip cmp-chip--file" data-state={u.failed ? "failed" : u.attachment ? "ready" : "uploading"}>
              {u.attachment?.isImage ? <img className="cmp-chip__thumb" src={fileUrl(u.attachment)} alt="" /> : null}
              <span className="cmp-chip__label" title={u.name}>
                {u.name}
              </span>
              {!u.attachment && !u.failed ? <span className="cmp-chip__state">올리는 중</span> : null}
              {u.failed ? <span className="cmp-chip__state">실패</span> : null}
              <button
                type="button"
                className="cmp-chip__x"
                aria-label={`${u.name} 빼기`}
                onClick={() => patchDraft(projectId, (d) => ({ ...d, uploads: d.uploads.filter((x) => x.key !== u.key), error: null }))}
              >
                <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                  <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </span>
          ))}
          {dragging ? <span className="cmp__hint">놓으면 첨부됩니다</span> : null}
          {notice ? (
            <span className="cmp__hint" role="status">
              {notice}
              {showThreadLink ? (
                <>
                  {" · "}
                  <a className="cmp__link" href={routeHash({ projectId, tab: "thread" })}>
                    대화에서 보기
                  </a>
                </>
              ) : null}
            </span>
          ) : null}
        </div>
        {canStop(recipient) || stopResult ? (
          <div className="cmp-stop" role="group" aria-label="지금 실행 멈추기">
            {canStop(recipient) ? (
              <>
                <span className="cmp-stop__what">
                  <StatusDot status={recipient.status} /> {recipient.name} {recipient.status === "blocked" ? "승인 창 앞" : "일하는 중"} · {runLabel(recipient, allTasks)}
                </span>
                <span className="cmp-stop__actions">
                  <GlassButton variant="ghost" size="s" disabled={stopping !== null} onClick={() => void stopRun(recipient, stopExpectation(recipient), false)}>
                    {stopping === recipient.id ? "멈추는 중…" : "멈춤"}
                  </GlassButton>
                  <GlassButton variant="glass" size="s" disabled={stopping !== null || !canSend} title="글을 먼저 대기열에 넣고 지금 턴을 멈춥니다. 멈춘 뒤 한 번만 전달됩니다" onClick={() => void send({ stop: true })}>
                    멈추고 이 글로 이어가기
                  </GlassButton>
                </span>
                <span className="cmp-stop__hint">그냥 보내면 지금 턴이 끝난 뒤 전달됩니다. 멈춤은 이 직원의 지금 턴 전체를 멈춥니다.</span>
              </>
            ) : null}
            {stopResult ? (
              <p className="cmp-stop__result" role="status" data-tone={stopResult.tone}>
                {stopResult.text}
              </p>
            ) : null}
          </div>
        ) : null}
        {draft.error ? (
          <p className="cmp__error" role="alert">
            {draft.error}
          </p>
        ) : null}
        {attempts.map((attempt) => (
          <div key={attempt.id} className="cmp__error" role="status">
            <span>{attempt.targetName ?? "원래 대상"}에게{attempt.payload.taskId ? ` · 작업 '${allTasks.find((t) => t.id === attempt.payload.taskId)?.title ?? attempt.payload.taskId}'` : ""} · {attempt.payload.text ? `${attempt.payload.text.slice(0, 60)}${attempt.payload.text.length > 60 ? "…" : ""}` : "첨부 메시지"}</span>
            <p>{attempt.status === "checking" ? "전송 결과 확인 중…" : attempt.error ?? "전송 결과를 확인하지 못했습니다"}</p>
            <GlassButton variant="ghost" size="s" disabled={attempt.status === "checking"} onClick={() => void submissions.reconcile(projectId)}>다시 확인</GlassButton>
            <GlassButton variant="ghost" size="s" disabled={attempt.status === "checking" || !project} onClick={() => void submissions.retry(projectId, attempt.id)}>같은 내용 재시도</GlassButton>
          </div>
        ))}
        <div className="cmp__row">
          <GlassButton variant="ghost" size="m" className="cmp__icon" ariaLabel="첨부" title="첨부" onClick={() => fileRef.current?.click()}>
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <path
                d="M16.5 9.2l-6.6 6.6a3.9 3.9 0 01-5.5-5.5l7-7a2.6 2.6 0 013.7 3.7l-6.9 7a1.3 1.3 0 01-1.9-1.9l6.3-6.3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </GlassButton>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attachFiles(projectId, [...(e.target.files ?? [])]);
              e.target.value = ""; // 같은 파일을 다시 고를 수 있게
            }}
          />
          <textarea
            ref={inputRef}
            className="cmp__input"
            rows={1}
            value={draft.text}
            placeholder={placeholder}
            aria-label="입력칸"
            aria-autocomplete="list"
            aria-controls={menuOpen ? "cmp-menu" : undefined}
            aria-activedescendant={!chipMenu && menuOpen ? `cmp-opt-${activeIndex}` : undefined}
            enterKeyHint={touchInput() ? "enter" : "send"}
            onChange={(e) => {
              const next = e.target.value;
              const at = e.target.selectionStart;
              patchDraft(projectId, (d) => ({ ...d, text: next, error: null }));
              setCaret(at);
              setActive(0);
              setChipMenu(false);
              if (!findMention(next, at)) setDismissedAt(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onBlur={() => {
              if (mention) setDismissedAt(mention.start);
            }}
            onFocus={() => setDismissedAt(null)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <GlassButton variant="primary" size="m" className="cmp__icon" ariaLabel="보내기" title="보내기" disabled={!canSend} onClick={() => void send()}>
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <path d="M10 16V4.5M5 9.5l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </GlassButton>
        </div>
      </Glass>
    </div>
  );
}
