// 본문 직접 고치기: 고친 글은 이 검토의 초안으로만 남는다(정본은 그대로). 그사이 다른 화면이 초안을 바꿨으면 덮지 않고 알린다.
// 서식 막대(굵게·기울임·취소선·코드·링크·제목·목록·번호·인용·코드 블록)와 단축키, 미리 보기를 둔다. 글은 마크다운 그대로 저장한다.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentAReviewDraft } from "@shared/agent-a";
import { GlassButton } from "../../glass";
import { saveRequests } from "../../lib/agent-a-review";
import { ApiError, api, errorText } from "../../lib/api";
import { applyEdit, codeBlock, heading, link, linePrefix, wrap, type MdEdit } from "../../lib/md-format";
import { newId } from "../../lib/store";
import { Markdown, useConfirmPress } from "../ui";

type Format = (text: string, start: number, end: number) => MdEdit;
const FORMATS: { key: string; label: string; title: string; run: Format }[] = [
  { key: "bold", label: "굵게", title: "굵게 (⌘B)", run: (t, s, e) => wrap(t, s, e, "**") },
  { key: "italic", label: "기울임", title: "기울임 (⌘I)", run: (t, s, e) => wrap(t, s, e, "*") },
  { key: "strike", label: "취소선", title: "취소선", run: (t, s, e) => wrap(t, s, e, "~~") },
  { key: "code", label: "코드", title: "코드 (⌘E)", run: (t, s, e) => wrap(t, s, e, "`") },
  { key: "link", label: "링크", title: "링크 (⌘K)", run: link },
  { key: "heading", label: "제목", title: "제목 수준 바꾸기(글 → # → ## → ###)", run: (t, s) => heading(t, s) },
  { key: "bullet", label: "목록", title: "목록", run: (t, s, e) => linePrefix(t, s, e, "bullet") },
  { key: "number", label: "번호", title: "번호 목록", run: (t, s, e) => linePrefix(t, s, e, "number") },
  { key: "quote", label: "인용", title: "인용", run: (t, s, e) => linePrefix(t, s, e, "quote") },
  { key: "block", label: "코드 블록", title: "코드 블록", run: codeBlock },
];
const KEYS: Record<string, string> = { b: "bold", i: "italic", e: "code", k: "link" };

export function DraftEditor({ fileId, session, canonical, onSaved, onClose }: { fileId: string; session: string; canonical: string; onSaved: (message: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<AgentAReviewDraft | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  /** 저장하려는데 다른 화면이 먼저 초안을 바꿨다: 그 초안. 내 글은 입력칸에 그대로 있다. */
  const [theirs, setTheirs] = useState<AgentAReviewDraft | null>(null);
  const discard = useConfirmPress();
  const input = useRef<HTMLTextAreaElement>(null);
  /** 같은 글을 같은 초안 판에서 다시 저장하면 같은 요청 id 로 보낸다(저장은 됐는데 응답만 잃은 저장을 서버가 확인한다). */
  const requests = useRef(saveRequests(newId));
  /** 글을 직접 바꾼 뒤(입력 명령을 받지 않는 브라우저) 다시 그려지면 고를 범위. */
  const reselect = useRef<{ value: string; from: number; to: number } | null>(null);
  useLayoutEffect(() => {
    const next = reselect.current, el = input.current;
    reselect.current = null;
    if (next && el && el.value === next.value) el.setSelectionRange(next.from, next.to);
  }, [text]);
  useEffect(() => {
    let stopped = false;
    api.agentAReview.draft(fileId, session).then((d) => {
      if (stopped) return;
      setDraft(d);
      setText(d.editedMarkdown ?? canonical);
    }, (e) => !stopped && setError(errorText(e)));
    return () => { stopped = true; };
  }, [fileId, session, canonical]);
  const save = async (markdown: string | null, revision: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.agentAReview.saveDraft(fileId, session, markdown, revision, requests.current.id(revision, markdown));
      requests.current.done();
      onSaved(markdown === null ? "고친 본문을 버렸습니다. 정본 본문을 다시 열었습니다." : "고친 본문을 초안으로 저장했습니다. 정본은 그대로입니다.");
    } catch (e) {
      setError(errorText(e));
      // 다른 화면이 먼저 저장했다. 덮지 않고 그 초안을 읽어 보여 준다.
      if (e instanceof ApiError && e.code === "AGENT_A_DRAFT_CONFLICT") await api.agentAReview.draft(fileId, session).then(setTheirs, () => {});
    } finally {
      setBusy(false);
    }
  };
  /** 서식 하나를 고른 글에 적용한다. 브라우저의 입력 명령으로 넣어 되돌리기(⌘Z)가 이어지게 하고, 받지 않는 브라우저에서는 글을 직접 바꾼다. */
  const format = (key: string) => {
    const el = input.current, f = FORMATS.find((x) => x.key === key);
    if (!el || !f || busy) return;
    const before = el.value;
    const edit = f.run(before, el.selectionStart, el.selectionEnd);
    const after = applyEdit(before, edit);
    el.focus();
    el.setSelectionRange(edit.from, edit.to);
    let done = false;
    try {
      done = document.execCommand("insertText", false, edit.insert);
    } catch {
      done = false;
    }
    // 입력 명령이 들어갔으면 글이 이미 바뀌어 있다. 바로 고른다(나중으로 미루면 그사이 대표가 고른 범위를 덮는다).
    if (done && el.value === after) return el.setSelectionRange(edit.selectFrom, edit.selectTo);
    reselect.current = { value: after, from: edit.selectFrom, to: edit.selectTo };
    setText(after);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.nativeEvent.isComposing) return;
    const key = KEYS[e.key.toLowerCase()];
    if (!key) return;
    e.preventDefault();
    format(key);
  };
  return (
    <section className="aar-editor" aria-label="본문 고치기">
      <p className="aar-note">고친 글은 이 검토의 초안으로만 남습니다. 정본은 바뀌지 않고, ‘검토 제출’ 때 고친 내용이 함께 넘어갑니다.</p>
      {!draft && error ? <p className="aar-error" role="alert">{error}</p> : null}
      {!draft && !error ? <p className="aar-note" role="status">초안을 읽는 중…</p> : null}
      {draft ? (
        <>
          <div className="aar-editor__bar" role="toolbar" aria-label="서식">
            {FORMATS.map((f) => <button key={f.key} type="button" className="vw-btn" title={f.title} disabled={busy} onMouseDown={(e) => e.preventDefault()} onClick={() => format(f.key)}>{f.label}</button>)}
            <button type="button" className="vw-btn aar-editor__preview" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>미리 보기</button>
          </div>
          <div className="aar-editor__panes" data-preview={preview ? "" : undefined}>
            <textarea ref={input} className="aar-editor__input" aria-label="본문(마크다운)" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
            {preview ? <div className="aar-editor__view" role="region" aria-label="미리 보기"><Markdown text={text} className="aar-md" /></div> : null}
          </div>
          {/* 저장 단추 바로 위에 둔다: 긴 입력칸 아래에서 눌러도 결과가 보이게 */}
          {error ? <p className="aar-error" role="alert">{error}</p> : null}
          {theirs ? (
            <div className="aar-card" role="status" aria-label="다른 화면의 초안">
              <p className="aar-note">다른 화면이 먼저 초안을 저장했습니다. 그 초안은 그대로 있고, 내 글도 위 입력칸에 그대로 있습니다.</p>
              <div className="aar-actions">
                <button type="button" className="vw-btn" disabled={busy} onClick={() => { setDraft(theirs); setText(theirs.editedMarkdown ?? canonical); setTheirs(null); setError(null); }}>다른 화면의 초안으로 바꾸기</button>
                <button type="button" className="vw-btn" disabled={busy} onClick={() => { const next = theirs; setDraft(next); setTheirs(null); void save(text, next.revision); }}>내 글로 그 초안의 본문 덮기</button>
              </div>
            </div>
          ) : null}
          <div className="aar-actions">
            <GlassButton variant="primary" size="s" disabled={busy || theirs !== null || text === (draft.editedMarkdown ?? canonical)} onClick={() => void save(text, draft.revision)}>{busy ? "저장하는 중" : "초안 저장"}</GlassButton>
            {draft.editedMarkdown !== null ? (
              <button type="button" className="vw-btn" data-armed={discard.armed ? "" : undefined} disabled={busy || theirs !== null} onClick={() => discard.press(() => void save(null, draft.revision))}>
                {discard.armed ? "한 번 더 눌러 버리기" : "고친 것 버리기"}
              </button>
            ) : null}
            <GlassButton variant="ghost" size="s" disabled={busy} onClick={onClose}>고치기 그만</GlassButton>
          </div>
        </>
      ) : null}
    </section>
  );
}
