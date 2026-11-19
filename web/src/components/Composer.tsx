// 모든 화면 아래 입력칸. Enter 전송 · Shift+Enter 줄바꿈(터치 기기는 소프트 키보드에 Shift 가 없어 Enter 가 줄바꿈, 보내기 버튼으로 전송) · 첨부(버튼·붙여넣기·드래그) · @직원 지정.
// 글·대상·첨부는 프로젝트별로 틀 밖과 localStorage 에 둔다: 프로젝트를 오가거나 틀이 다시 그려져도, 새로고침·앱 재시작 뒤에도 쓰던 글이 남아야 한다.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import { canAnswerOwnerStatus } from "@shared/owner-status-query";
import type { Member, MemberStatus, StopReq, Task } from "@shared/types";
import { GlassButton, Glass } from "../glass";
import { api, errorText, fileUrl, getCredentialGeneration } from "../lib/api";
import ConnectGate, { isGateRejection, useGate } from "./ConnectGate";
import { getState, newId, refresh, routeHash, useProject, useRoute } from "../lib/store";
import type { Draft, SubmissionManager } from "../lib/submissions";
import { chooseTask, commandSubmissions, submissions, useSubmissionDraft } from "../lib/submission-client";
import { StatusDot } from "./ui";
import { chipTasks, filterTasks, findSlash, taskActivity } from "../lib/tasks";
import { formatRelative } from "../lib/time";
import { canStop, runLabel, stopExpectation, stopNotice } from "../lib/stop";
import "../styles/composer.css";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const NOTICE_MS = 4000;
/** 마우스를 올려 두면 목록이 뜨기까지(대표 2026-11-14: 1초). */
const HOVER_OPEN_MS = 1000;
/** 칩에서 목록으로 마우스를 옮기는 사이에 닫히지 않게 둔 틈. */
const HOVER_CLOSE_MS = 300;
const STOP_NOTICE_MS = 15000;

function attachFiles(manager: SubmissionManager, projectId: string, files: File[]): void {
  for (const file of files) {
    const name = file.name || "첨부";
    const ticket = manager.beginUpload(projectId, { key: newId(), name });
    if (file.size > MAX_UPLOAD_BYTES) {
      manager.finishUpload(ticket, null, "파일은 50MB 까지 올릴 수 있습니다");
      continue;
    }
    api.upload(file, name, { project: projectId, target: ticket.targetId }).then(
      (attachment) => manager.finishUpload(ticket, attachment),
      (e) => {
        // 연결 때문에 막힌 첨부는 칩을 실패로 남기지 않고 어디에 막혔는지만 알린다.
        if (isGateRejection(e)) {
          if (manager.refuseUpload(ticket, e.message)) void refresh();
          return;
        }
        // A failed upload remains visible. Selecting the file again is required
        // because browsers cannot restore a File after a page reload.
        manager.finishUpload(ticket, null, errorText(e));
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

const useWindowFileDrag = (manager: SubmissionManager, projectId: string, enabled: boolean): boolean => {
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
      attachFiles(manager, projectId, [...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [manager, projectId, enabled]);
  return dragging;
};

export default function Composer() {
  const route = useRoute();
  const state = useProject();
  const projectId = route.projectId;
  const project = state?.project.id === projectId ? state : null;
  const commandMode = route.tab === "home" && !project?.project.isHq && projectId !== "hq";
  const manager = commandMode ? commandSubmissions : submissions;
  const { draft, attempts } = useSubmissionDraft(projectId, manager);
  const patchDraft = (id: string, patch: (draft: Draft) => Draft) => manager.patchDraft(id, patch);
  const gate = useGate();
  const statusOnly = commandMode && (gate.kind === "runner_off" || gate.kind === "backend_down");
  const dragging = useWindowFileDrag(manager, projectId, gate.ok);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  /** 칩으로 연 목록: 받는 사람(target) 또는 업무(task). hover 로 열었으면 마우스가 떠나면 닫는다. */
  const [opened, setOpened] = useState<{ kind: "target" | "task"; via: "hover" | "click" } | null>(null);
  const chipMenu = opened?.kind === "target";
  const taskMenu = opened?.kind === "task";
  const setChipMenu = (on: boolean) => setOpened(on ? { kind: "target", via: "click" } : null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect(() => clearHover, []);
  /** 마우스만: 1초 올려 두면 연다. 손가락 누름(touch·pen)은 hover 로 치지 않는다. */
  const hoverEnter = (kind: "target" | "task") => (e: { pointerType: string }) => {
    if (e.pointerType !== "mouse") return;
    clearHover();
    if (opened?.kind === kind) return;
    hoverTimer.current = setTimeout(() => {
      setOpened((cur) => cur ?? { kind, via: "hover" });
      setActive(0);
    }, HOVER_OPEN_MS);
  };
  const hoverLeave = (e: { pointerType: string }) => {
    if (e.pointerType !== "mouse") return;
    clearHover();
    hoverTimer.current = setTimeout(() => setOpened((cur) => (cur?.via === "hover" ? null : cur)), HOVER_CLOSE_MS);
  };
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  /** 멈춤을 보내는 중인 직원. 결과가 올 때까지 멈춤 버튼은 눌리지 않는다(서버도 겹친 요청을 한 번으로 합친다). */
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopResult, setStopResult] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  // 게이트가 열리면 칸이 새로 그려진다. 값이 그대로여도 높이를 다시 잰다.
  useAutoGrow(inputRef, gate.ok || statusOnly ? draft.text : "");

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
  }, [manager, projectId]);

  useEffect(() => {
    if (!opened) return;
    const outside = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpened(null);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [opened]);

  const isHq = project?.project.isHq ?? projectId === "hq";
  const members = project?.members ?? [];
  const lead = members.find((m) => m.kind === "root" || m.kind === "conductor") ?? null;
  const workers = members.filter((m) => m.kind === "worker");
  const target = (commandMode ? members : workers).find((m) => m.id === draft.targetId) ?? null;
  const allTasks = project?.tasks ?? [];
  const task = draft.taskId ? allTasks.find((t) => t.id === draft.taskId) ?? null : null;
  // 업무 칩은 받는 사람과 상관없이 늘 같은 목록이다. 업무 이름만 보이고 맡은 직원은 붙이지 않는다(업무에는 여러 직원이 붙는다).
  const shownTasks = commandMode ? allTasks.filter(t => !t.mergedInto || t.id === task?.id) : chipTasks(allTasks, project?.messages ?? [], task?.id ?? null);
  const staleSelection = commandMode && ((!!draft.targetId && !target) || (!!draft.taskId && !task));
  const leadName = lead?.name ?? (isHq ? "본사 AI" : "총괄");
  const entries: MenuEntry[] = [
    { id: null, name: commandMode ? "자동 배정" : leadName, handle: null, role: "기본", status: commandMode ? null : lead?.status ?? null },
    ...(commandMode && lead ? [{ id: lead.id, name: lead.name, handle: lead.handle, role: "총괄", status: lead.status }] : []),
    ...workers.map((m) => ({ id: m.id, name: m.name, handle: m.handle, role: m.role, status: m.status })),
  ];

  const mention = findMention(draft.text, caret);
  const mentionOpen = mention !== null && mention.start !== dismissedAt;
  const matches = mentionOpen && !opened
    ? entries.filter((e) => e.name.toLowerCase().includes(mention.query) || (e.handle ?? "").includes(mention.query))
    : entries;
  // 입력칸의 '/': 업무 목록을 띄워 거기서 고른다. '@'가 먼저 열려 있으면 그쪽이 앞선다.
  const slash = findSlash(draft.text, caret);
  const slashOpen = slash !== null && slash.start !== dismissedAt && !opened && !(mentionOpen && matches.length > 0);
  type TaskEntry = { task: Task | null };
  const taskEntries: TaskEntry[] = slashOpen
    ? [...(slash.query ? [] : [{ task: null }]), ...filterTasks(shownTasks, slash.query).map((t) => ({ task: t }))]
    : [{ task: null }, ...shownTasks.map((t) => ({ task: t }))];
  const showTaskMenu = taskMenu || (slashOpen && taskEntries.length > 0);
  const menuOpen = chipMenu || (!opened && mentionOpen && matches.length > 0);
  const listLength = showTaskMenu ? taskEntries.length : matches.length;
  const activeIndex = Math.min(active, Math.max(listLength - 1, 0));

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
  const pickTask = (next: Task | null) => chooseTask(projectId, next, manager);
  /** 목록에서 업무를 고른다. '/'로 열었으면 친 '/글'을 지운다. */
  const pickTaskEntry = (entry: TaskEntry) => {
    setOpened(null);
    setActive(0);
    if (slash && slashOpen) {
      const rest = draft.text.slice(slash.start + slash.query.length + 1).replace(/^ /, "");
      const text = draft.text.slice(0, slash.start) + rest;
      patchDraft(projectId, (d) => ({ ...d, text }));
      setCaret(slash.start);
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(slash.start, slash.start));
    }
    pickTask(entry.task);
    inputRef.current?.focus();
  };

  // 업무 칩은 한 줄에 들어가는 만큼만 이름 전체로 보인다. 넘치는 칩은 둘째 줄로 밀려 가려지고, 그 수를 '+N'으로 보인다.
  // 고른 업무가 가려지면 '전체' 바로 뒤로 당겨 늘 보이게 한다.
  const tasksRef = useRef<HTMLDivElement>(null);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [pinned, setPinned] = useState<string | null>(null);
  /** '전체' 칩 폭. 고른 칩은 '전체' 옆 남은 폭까지만 넓어져, 이름이 줄보다 길어도(폰) 둘째 줄로 밀려 가려지지 않는다. */
  const [allWidth, setAllWidth] = useState(0);
  const pinnedId = task && pinned === task.id ? pinned : null;
  const lineTasks = pinnedId ? [shownTasks.find((t) => t.id === pinnedId)!, ...shownTasks.filter((t) => t.id !== pinnedId)].filter(Boolean) : shownTasks;
  const lineKey = lineTasks.map((t) => `${t.id}:${t.title}`).join("|");
  useLayoutEffect(() => {
    const row = tasksRef.current;
    if (!row) return;
    const measure = () => {
      const chips = [...row.querySelectorAll<HTMLElement>(".cmp-task[data-id]")];
      const top = row.querySelector<HTMLElement>(".cmp-task")?.offsetTop ?? 0;
      const hidden = chips.filter((c) => c.offsetTop > top + 2).map((c) => c.dataset.id!);
      setHiddenIds((cur) => (cur.join() === hidden.join() ? cur : hidden));
      setAllWidth(row.querySelector<HTMLElement>(".cmp-task")?.offsetWidth ?? 0);
      if (task && hidden.includes(task.id)) setPinned(task.id);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, [lineKey, task?.id]);

  /** 메뉴가 받아 간 키면 true. 초점이 입력칸에 있든 칩에 있든 같은 키로 움직인다. */
  const menuKey = (e: KeyboardEvent): boolean => {
    if (!menuOpen && !showTaskMenu) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + listLength) % listLength);
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      if (showTaskMenu) {
        const entry = taskEntries[activeIndex];
        if (entry) pickTaskEntry(entry);
      } else {
        const entry = matches[activeIndex];
        if (entry) pick(entry);
      }
    } else if (e.key === "Escape") {
      setOpened(null);
      if (showTaskMenu && slash && slashOpen) setDismissedAt(slash.start);
      else if (mention) setDismissedAt(mention.start);
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
  const allowed = gate.ok || (statusOnly && canAnswerOwnerStatus({intent:"execute", text, targetMemberId:draft.targetId, attachmentIds:ready.map(a => a.id)}, isHq));
  const canSend = !staleSelection && allowed && !!project && !uploading && !failedUpload && (text.length > 0 || ready.length > 0);
  // 지금 글이 갈 사람. 그 사람이 일하는 중이면 입력칸 위에 멈춤 줄을 보인다.
  const recipient: Member | null = target ?? (commandMode ? null : lead);

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
    const receiver = to ?? (commandMode ? null : lead);
    const stopWith = opts.stop && canStop(receiver) && !stopping ? { member: receiver, req: stopExpectation(receiver) } : null;
    const result = manager.submit(
      projectId,
      draft,
      { ...(commandMode && !opts.stop ? { intent: "execute" as const } : {}), text: body, targetMemberId: to?.id ?? null, attachmentIds: ready.map((a) => a.id), taskId: task?.id ?? null },
      { targetName: to?.name ?? (commandMode ? null : leadName), attachments: ready },
    );
    // submit persists synchronously before clearing the input. A storage failure
    // leaves the draft intact and blocks the network request.
    if (manager.snapshot(projectId).draft.error) return;
    setCaret(0);
    setNotice(null);
    inputRef.current?.focus();
    const saved = await result;
    const activeRoute = getState().route;
    if (!saved || getCredentialGeneration() !== session || activeRoute.projectId !== projectId) return;
    if (stopWith) await stopRun(stopWith.member, stopWith.req, true);
    else if (activeRoute.tab !== route.tab) return;
    else if (commandMode && !to) setNotice("명령을 접수했습니다");
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
    if (!gate.ok || files.length === 0) return;
    // 표 앱은 글과 그림을 함께 복사한다. 글을 막으면 표 내용이 사라진다. 파인더는 파일 이름을 글로 함께 주므로 그것만 거른다.
    const typed = e.clipboardData.getData("text/plain").trim();
    const onlyNames = typed.split(/[\r\n]+/).every((line) => files.some((f) => f.name === line.trim()));
    if (!typed || onlyNames) e.preventDefault();
    attachFiles(manager, projectId, files);
  };

  const placeholder = statusOnly ? "진행 상황 질문" : commandMode && !target ? (task ? `${task.title}에 이어서 지시` : "새 명령 입력") : task ? `'${task.title}' 업무로 ${target?.name ?? leadName}에게` : target ? `${target.name}에게 직접 지시` : isHq ? "본사 AI에게 — 새 프로젝트 만들기 등" : "지시나 질문";
  const showThreadLink = notice !== null && route.tab !== "thread" && !commandMode;

  if (!gate.ok && !statusOnly) {
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
      {showTaskMenu ? (
        <ul
          className="cmp-menu cmp-menu--tasks"
          role="listbox"
          id="cmp-menu"
          aria-label="업무 고르기"
          onPointerEnter={(e) => e.pointerType === "mouse" && clearHover()}
          onPointerLeave={hoverLeave}
        >
          {taskEntries.map((entry, i) => {
            const t = entry.task;
            const last = t ? taskActivity(t, project?.messages ?? []) : null;
            return (
              <li
                key={t?.id ?? "all"}
                id={`cmp-opt-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                aria-current={(t ? task?.id === t.id : !task) ? "true" : undefined}
                className="cmp-menu__item cmp-menu__item--task"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickTaskEntry(entry)}
              >
                <span className="cmp-menu__main">
                  <span className="cmp-menu__name">{t ? t.title : commandMode ? "새 명령" : "전체"}</span>
                  <span className="cmp-menu__sub">{t ? [last ? `최근 글 ${formatRelative(last)}` : "글 없음", t.branch].filter(Boolean).join(" · ") : commandMode ? "" : "업무를 고르지 않고 모든 글"}</span>
                </span>
                {(t ? task?.id === t.id : !task) ? <span className="cmp-menu__on">고름</span> : null}
              </li>
            );
          })}
        </ul>
      ) : menuOpen && matches.length > 0 ? (
        <ul
          className="cmp-menu"
          role="listbox"
          id="cmp-menu"
          aria-label="보낼 대상"
          onPointerEnter={(e) => e.pointerType === "mouse" && clearHover()}
          onPointerLeave={hoverLeave}
        >
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
            aria-label={`보낼 대상: ${target?.name ?? (commandMode ? "자동 배정" : leadName)}. 눌러서 바꾸기`}
            aria-haspopup="listbox"
            aria-expanded={chipMenu}
            aria-controls={chipMenu ? "cmp-menu" : undefined}
            aria-activedescendant={chipMenu ? `cmp-opt-${activeIndex}` : undefined}
            onClick={() => {
              clearHover();
              // 마우스를 올려 열린 목록은 눌러도 닫지 않고 그대로 둔다(누른 뒤 손을 떼도 남게)
              setOpened((cur) => (cur?.kind === "target" ? (cur.via === "hover" ? { kind: "target", via: "click" } : null) : { kind: "target", via: "click" }));
              setActive(0);
            }}
            onPointerEnter={hoverEnter("target")}
            onPointerLeave={hoverLeave}
            onKeyDown={(e) => void menuKey(e)}
          >
            <span className="cmp-chip__label">{target ? `@${target.name}` : commandMode ? "자동 배정" : isHq ? "본사 AI" : "총괄"}</span>
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {commandMode && shownTasks.length > 0 ? (
            <button type="button" className="cmp-task cmp-command-task" aria-label={task ? `선택 업무: ${task.title}` : "기존 업무 선택"}
              aria-haspopup="listbox" aria-expanded={taskMenu}
              onClick={() => { setOpened(taskMenu ? null : {kind:"task",via:"click"}); setActive(0); }}
              onKeyDown={menuKey}>
              {task?.title ?? "업무 선택"}
            </button>
          ) : shownTasks.length > 0 || task ? (
            <div className="cmp-taskbar" onPointerEnter={hoverEnter("task")} onPointerLeave={hoverLeave}>
              <div ref={tasksRef} className="cmp-tasks" role="group" aria-label="업무 고르기">
                <button type="button" className="cmp-task" aria-pressed={!task} onClick={() => pickTask(null)}>
                  전체
                </button>
                {lineTasks.map((t) => {
                  const off = hiddenIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className="cmp-task"
                      data-id={t.id}
                      aria-pressed={task?.id === t.id}
                      style={task?.id === t.id && allWidth ? { maxWidth: `calc(100% - ${allWidth + 4}px)` } : undefined}
                      aria-hidden={off ? "true" : undefined}
                      tabIndex={off ? -1 : undefined}
                      title={[t.title, t.branch].filter(Boolean).join(" · ")}
                      onClick={() => pickTask(task?.id === t.id ? null : t)}
                    >
                      <span className="cmp-task__title">{t.title}</span>
                    </button>
                  );
                })}
              </div>
              {hiddenIds.length > 0 ? (
                <button
                  type="button"
                  className="cmp-task cmp-task--more"
                  aria-label={`업무 ${hiddenIds.length}개 더 보기`}
                  aria-haspopup="listbox"
                  aria-expanded={taskMenu}
                  onClick={() => {
                    clearHover();
                    setOpened((cur) => (cur?.kind === "task" && cur.via === "click" ? null : { kind: "task", via: "click" }));
                    setActive(0);
                  }}
                  onKeyDown={(e) => void menuKey(e)}
                >
                  +{hiddenIds.length}
                </button>
              ) : null}
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
        {gate.ok && (canStop(recipient) || stopResult) ? (
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
        {staleSelection && <p className="cmp__error" role="alert">
          이전에 선택한 업무나 담당자를 찾을 수 없습니다. <button type="button" onClick={() => patchDraft(projectId,d => ({...d,targetId:null,taskId:null}))}>선택 해제</button>
        </p>}
        {draft.error ? (
          <p className="cmp__error" role="alert">
            {draft.error}
          </p>
        ) : null}
        {attempts.filter((attempt) => attempt.status !== "sending").map((attempt) => (
          <div key={attempt.id} className="cmp__error" role="status">
            <span>{attempt.targetName ?? "원래 대상"}에게{attempt.payload.taskId ? ` · 작업 '${allTasks.find((t) => t.id === attempt.payload.taskId)?.title ?? attempt.payload.taskId}'` : ""} · {attempt.payload.text ? `${attempt.payload.text.slice(0, 60)}${attempt.payload.text.length > 60 ? "…" : ""}` : "첨부 메시지"}</span>
            <p>{attempt.status === "checking" ? "전송 결과 확인 중…" : attempt.error ?? "전송 결과를 확인하지 못했습니다"}</p>
            <GlassButton variant="ghost" size="s" disabled={attempt.status === "checking"} onClick={() => void manager.reconcile(projectId)}>다시 확인</GlassButton>
            <GlassButton variant="ghost" size="s" disabled={attempt.status === "checking" || !project || (!gate.ok && !(statusOnly && canAnswerOwnerStatus(attempt.payload, isHq)))} onClick={() => void manager.retry(projectId, attempt.id)}>같은 내용 재시도</GlassButton>
          </div>
        ))}
        <div className="cmp__row">
          <GlassButton variant="ghost" size="m" className="cmp__icon" ariaLabel="첨부" title="첨부" disabled={!gate.ok} onClick={() => fileRef.current?.click()}>
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
              attachFiles(manager, projectId, [...(e.target.files ?? [])]);
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
            aria-controls={menuOpen || showTaskMenu ? "cmp-menu" : undefined}
            aria-activedescendant={!opened && (menuOpen || showTaskMenu) ? `cmp-opt-${activeIndex}` : undefined}
            enterKeyHint={touchInput() ? "enter" : "send"}
            onChange={(e) => {
              const next = e.target.value;
              const at = e.target.selectionStart;
              patchDraft(projectId, (d) => ({ ...d, text: next, error: null }));
              setCaret(at);
              setActive(0);
              setOpened(null);
              if (!findMention(next, at) && !findSlash(next, at)) setDismissedAt(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onBlur={() => {
              if (mention) setDismissedAt(mention.start);
              else if (slash) setDismissedAt(slash.start);
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
