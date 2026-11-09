// 모든 화면 아래 입력칸. Enter 전송 · Shift+Enter 줄바꿈(터치 기기는 소프트 키보드에 Shift 가 없어 Enter 가 줄바꿈, 보내기 버튼으로 전송) · 첨부(버튼·붙여넣기·드래그) · @직원 지정.
// 글·대상·첨부는 프로젝트별로 틀 밖과 localStorage 에 둔다: 프로젝트를 오가거나 틀이 다시 그려져도, 새로고침·앱 재시작 뒤에도 쓰던 글이 남아야 한다.
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import type { MemberStatus } from "@shared/types";
import { GlassButton, Glass } from "../glass";
import { api, errorText, fileUrl, getCredentialGeneration } from "../lib/api";
import ConnectGate, { isGateRejection, useGate } from "./ConnectGate";
import { getState, newId, refresh, routeHash, useProject, useRoute } from "../lib/store";
import type { Draft } from "../lib/submissions";
import { submissions, useSubmissionDraft } from "../lib/submission-client";
import { StatusDot } from "./ui";
import "../styles/composer.css";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const NOTICE_MS = 4000;

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

  // 게이트가 열리면 칸이 새로 그려진다. 값이 그대로여도 높이를 다시 잰다.
  useAutoGrow(inputRef, gate.ok ? draft.text : "");

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    setChipMenu(false);
    setNotice(null);
    setDismissedAt(null);
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

  const send = async () => {
    if (uploading || failedUpload) {
      patchDraft(projectId, (d) => ({ ...d, error: uploading ? "첨부를 올리는 중입니다. 끝나면 보내 주세요" : "올리지 못한 첨부를 지운 뒤 보내 주세요" }));
      return;
    }
    if (!canSend) return;
    const typed = target ? null : leadingMention(text, workers);
    const to = typed?.member ?? target;
    const body = typed?.rest ?? text;
    const session = getCredentialGeneration();
    const result = submissions.submit(
      projectId,
      draft,
      { text: body, targetMemberId: to?.id ?? null, attachmentIds: ready.map((a) => a.id) },
      { targetName: to?.name ?? leadName, attachments: ready },
    );
    // submit persists synchronously before clearing the input. A storage failure
    // leaves the draft intact and blocks the network request.
    if (submissions.snapshot(projectId).draft.error) return;
    setCaret(0);
    setNotice(null);
    inputRef.current?.focus();
    const saved = await result;
    if (saved && getCredentialGeneration() === session && getState().route.projectId === projectId) setNotice(`${to?.name ?? leadName}에게 보냈습니다`);
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

  const placeholder = target ? `${target.name}에게 직접 지시` : isHq ? "본사 AI에게 — 새 프로젝트 만들기 등" : "지시나 질문";
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
        {draft.error ? (
          <p className="cmp__error" role="alert">
            {draft.error}
          </p>
        ) : null}
        {attempts.map((attempt) => (
          <div key={attempt.id} className="cmp__error" role="status">
            <span>{attempt.targetName ?? "원래 대상"}에게 · {attempt.payload.text ? `${attempt.payload.text.slice(0, 60)}${attempt.payload.text.length > 60 ? "…" : ""}` : "첨부 메시지"}</span>
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
