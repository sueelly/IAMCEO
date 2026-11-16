// 문서에 묻기(Ask AI): 댓글을 남기지 않고 이 문서에 대해 바로 묻고 답을 받는다. 대화는 문서마다 Agent-A 에 남아 다시 열어도 이어진다.
// 답은 정본을 바꾸지 않는다. 답을 받는 동안 글자가 이어 붙고, 멈출 수 있다. 한 질문·답에서 대화를 갈라 다른 조건으로 이어 물을 수 있고,
// 답을 쓰는 중에 AI 가 도구를 쓰려고 허락을 구하면 허용·거절을 고른다.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAChatEntry, AgentAChatHistory, AgentAChatSession, AgentAReviewAiCatalog, AgentAReviewAiSettings } from "@shared/agent-a";
import { GlassButton } from "../../glass";
import { ApiError, api, errorText } from "../../lib/api";
import { oneLine } from "../../lib/agent-a-review";
import { newId } from "../../lib/store";
import { enterSends, isComposing, useAutoGrow } from "../Composer";
import { Markdown, Time } from "../ui";
import { AiPicker } from "./AiPicker";

interface Permission {
  conversation: string;
  requestId: string;
  tool: string;
  title: string;
  detail: string;
}

export function ChatPanel({ fileId, session, quote, onQuoteUsed, catalog, ai, onAi, onBack, draft, setDraft }: {
  fileId: string;
  session: string;
  /** 본문에서 '묻기'로 고른 글. 다음 질문 하나에 함께 보낸다. */
  quote: string | null;
  onQuoteUsed: () => void;
  catalog: AgentAReviewAiCatalog | null;
  ai: AgentAReviewAiSettings;
  onAi: (next: AgentAReviewAiSettings) => void;
  onBack: () => void;
  draft: string;
  setDraft: (text: string) => void;
}) {
  const [conversation, setConversation] = useState<string | null>(null);
  const [entries, setEntries] = useState<AgentAChatEntry[] | null>(null);
  /** 갈라 낸 대화면 원래 대화의 id. */
  const [branchedFrom, setBranchedFrom] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentAChatSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  /** 답을 쓰는 중에 AI 가 구한 허락. 답하거나 답이 끝나면 사라진다. */
  const [permission, setPermission] = useState<Permission | null>(null);
  const [answering, setAnswering] = useState(false);
  const abort = useRef<AbortController | null>(null);
  /** 같은 질문을 다시 보내도(응답을 못 받았을 때) 질문은 하나다: 보낼 때까지 같은 id 를 쓴다. */
  const pending = useRef<{ key: string; id: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  useAutoGrow(input, draft);

  /** 대화 불러오기의 차례. 불러오는 사이 질문을 보내거나 다른 대화를 고르면 늦게 온 응답은 버린다(방금 쓴 질문을 지우지 않게). */
  const loadSeq = useRef(0);
  const show = (h: AgentAChatHistory) => {
    setConversation(h.conversationId);
    setEntries(h.entries);
    setBranchedFrom(h.branchedFrom);
    setSessions(null);
    setError(null);
  };
  const load = useCallback(async (id?: string | null) => {
    const mine = ++loadSeq.current;
    try {
      const h = await api.agentAReview.chat(fileId, session, id);
      if (mine !== loadSeq.current) return;
      setConversation(h.conversationId);
      setEntries(h.entries);
      setBranchedFrom(h.branchedFrom);
      setError(null);
    } catch (e) {
      if (mine === loadSeq.current) setError(errorText(e));
    }
  }, [fileId, session]);
  useEffect(() => {
    void load();
    return () => abort.current?.abort();
  }, [load]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [entries, permission]);

  const ask = async () => {
    const prompt = draft.trim();
    if (!prompt || asking) return;
    const key = `${quote ?? ""}\n${prompt}`;
    if (pending.current?.key !== key) pending.current = { key, id: newId() };
    const id = pending.current.id;
    setAsking(true);
    setError(null);
    setPermission(null);
    // 아직 오고 있는 '대화 불러오기' 응답은 이 질문보다 옛 상태다. 버린다.
    loadSeq.current++;
    let asked: string | null = conversation;
    setEntries((cur) => [...(cur ?? []).filter((e) => e.id !== id), { id, prompt, quote, createdAt: Date.now(), answer: "", writing: true, error: null, provider: null }]);
    const patch = (change: (e: AgentAChatEntry) => AgentAChatEntry) => setEntries((cur) => (cur ?? []).map((e) => (e.id === id ? change(e) : e)));
    abort.current = new AbortController();
    try {
      await api.agentAReview.chatAsk(fileId, session, { id, prompt, quote, ai }, (event) => {
        if (event.type === "start") {
          asked = event.conversationId;
          setConversation(event.conversationId);
        } else if (event.type === "permission") {
          if (asked) setPermission({ conversation: asked, requestId: event.requestId, tool: event.tool, title: event.title, detail: event.detail });
        } else {
          // 답이 다시 이어지거나 끝났으면 앞의 허락 요청은 지난 것이다.
          setPermission(null);
          if (event.type === "delta") patch((e) => ({ ...e, answer: e.answer + event.text }));
          else if (event.type === "error") patch((e) => ({ ...e, error: event.message, writing: false }));
          else if (event.type === "done") patch((e) => ({ ...e, writing: false, answer: e.answer || event.text }));
        }
      }, abort.current.signal);
      pending.current = null;
      setDraft("");
      onQuoteUsed();
      // 서버에 남은 대화로 맞춘다(이 질문보다 앞선 질문·답이 아직 화면에 없을 수 있다).
      await load(asked);
    } catch (e) {
      // 보내지 못했거나 끊겼다. 쓴 글은 그대로 둔다. 이미 받은 질문이면(같은 id) 대화를 다시 읽어 답을 보인다.
      setError(errorText(e));
      await load(conversation);
    } finally {
      abort.current = null;
      setAsking(false);
      setPermission(null);
      patch((e) => (e.writing ? { ...e, writing: false } : e));
    }
  };
  const stop = async () => {
    if (!conversation) return;
    try {
      await api.agentAReview.chatAbort(fileId, session, conversation);
    } catch (e) {
      setError(errorText(e));
    }
  };
  /** 대표가 고른 대로만 답한다. 이미 지난 요청이면 카드를 걷는다. */
  const respond = async (allow: boolean) => {
    if (!permission || answering) return;
    setAnswering(true);
    setError(null);
    try {
      await api.agentAReview.chatPermission(fileId, session, permission.conversation, permission.requestId, allow);
      setPermission(null);
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.code === "AGENT_A_PERMISSION_NOT_PENDING") setPermission(null);
    } finally {
      setAnswering(false);
    }
  };
  /** 고른 질문까지(point=question) 또는 그 답까지(answer) 복사한 새 대화로 옮긴다. 원래 대화는 그대로 남는다. */
  const fork = (questionId: string, point: "question" | "answer") => {
    if (asking || !conversation) return;
    loadSeq.current++;
    void api.agentAReview.chatFork(fileId, session, conversation, questionId, point).then(show, (e) => setError(errorText(e)));
  };
  const select = (id: string) => {
    loadSeq.current++;
    void api.agentAReview.chatSelect(fileId, session, id).then(show, (e) => setError(errorText(e)));
  };

  return (
    <section className="aar-pane" aria-label="문서에 묻기">
      <header className="aar-pane__head">
        <button type="button" className="aar-back" aria-label="댓글 목록으로" onClick={onBack}>←</button>
        <strong>문서에 묻기</strong>
      </header>
      <div className="aar-pane__tools" role="group" aria-label="대화 관리">
        <button type="button" className="vw-btn" disabled={asking} onClick={() => { loadSeq.current++; void api.agentAReview.chatNew(fileId, session).then(show, (e) => setError(errorText(e))); }}>새 대화</button>
        <button type="button" className="vw-btn" aria-expanded={sessions !== null} disabled={asking} onClick={() => (sessions ? setSessions(null) : void api.agentAReview.chatSessions(fileId, session).then(setSessions, (e) => setError(errorText(e))))}>앞 대화</button>
        {asking ? <button type="button" className="vw-btn" onClick={() => void stop()}>답 멈춤</button> : null}
      </div>
      {sessions ? (
        <ul className="aar-list" aria-label="앞 대화">
          {sessions.length === 0 ? <li className="aar-note">앞 대화가 없습니다.</li> : null}
          {[...sessions].reverse().map((c) => (
            <li key={c.conversationId}>
              <button type="button" className="aar-row" aria-current={c.conversationId === conversation ? "true" : undefined} disabled={asking} onClick={() => select(c.conversationId)}>
                <span className="aar-row__text">{c.label ? oneLine(c.label, 70) : "빈 대화"}</span>
                <span className="aar-row__meta">{c.current ? <span className="aa-tag">지금 대화</span> : null}<Time iso={new Date(c.updatedAt || c.createdAt).toISOString()} /></span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div ref={log} className="aar-pane__body" role="log" aria-label="문서 대화">
        {branchedFrom ? (
          <p className="aar-note" data-branched="">
            앞 대화에서 갈라 낸 대화입니다. 원래 대화는 그대로 있습니다.{" "}
            <button type="button" className="aa-link" disabled={asking} onClick={() => select(branchedFrom)}>원래 대화 보기</button>
          </p>
        ) : null}
        {entries === null && !error ? <p className="aar-note" role="status">대화를 불러오는 중…</p> : null}
        {entries?.length === 0 ? <p className="aar-note">이 문서에 대해 물어보세요. 답은 정본을 바꾸지 않고, 대화는 이 문서에 남습니다.</p> : null}
        {entries?.map((e) => (
          <div key={e.id} className="aar-chat" data-question={e.id}>
            <article className="aar-msg">
              <p className="aar-msg__who">나</p>
              {e.quote ? <blockquote className="aar-quote">{e.quote}</blockquote> : null}
              <p className="aar-msg__text">{e.prompt}</p>
            </article>
            <article className="aar-msg" data-ai="">
              <p className="aar-msg__who">{e.provider ?? "Agent-A"}</p>
              {e.answer ? <Markdown text={e.answer} className="aar-msg__body" /> : null}
              {e.writing ? <p className="aar-msg__writing" role="status">답을 쓰는 중…</p> : null}
              {e.error ? <p className="aar-msg__error" role="status">{e.error}</p> : null}
            </article>
            {e.writing ? null : (
              <p className="aar-chat__fork">
                여기서 새 대화로 가르기
                <button type="button" className="aa-link" disabled={asking} aria-label={`‘${oneLine(e.prompt, 30)}’ 질문까지 복사해 새 대화로`} onClick={() => fork(e.id, "question")}>질문까지</button>
                <button type="button" className="aa-link" disabled={asking || !e.answer} aria-label={`‘${oneLine(e.prompt, 30)}’의 답까지 복사해 새 대화로`} onClick={() => fork(e.id, "answer")}>답까지</button>
              </p>
            )}
          </div>
        ))}
        {permission ? (
          <section className="aar-card" role="group" aria-label="AI 의 권한 요청" data-permission={permission.requestId}>
            <header className="aar-card__head"><strong>AI 가 허락을 구합니다</strong><span className="aa-tag">{permission.tool}</span></header>
            {permission.title ? <p className="aar-msg__text">{permission.title}</p> : null}
            {permission.detail ? <pre className="aar-diagram__code">{permission.detail}</pre> : null}
            <p className="aar-card__meta">허용하면 AI 가 이 요청대로 도구를 씁니다. 거절하면 쓰지 않고 답을 이어 갑니다. 고를 때까지 답은 멈춰 있습니다.</p>
            <div className="aar-actions">
              <GlassButton variant="primary" size="s" disabled={answering} onClick={() => void respond(true)}>허용</GlassButton>
              <GlassButton variant="glass" size="s" disabled={answering} onClick={() => void respond(false)}>거절</GlassButton>
            </div>
          </section>
        ) : null}
        {error ? <p className="aar-error" role="alert">{error}</p> : null}
      </div>
      <div className="aar-pane__foot">
        {quote ? (
          <p className="aar-note">
            고른 글과 함께 묻습니다: “{oneLine(quote, 60)}” <button type="button" className="aa-link" onClick={onQuoteUsed}>빼기</button>
          </p>
        ) : null}
        <AiPicker catalog={catalog} value={ai} onChange={onAi} disabled={asking} />
        <div className="aar-compose">
          <textarea ref={input} className="aar-compose__input" aria-label="문서에 묻기" placeholder="이 문서에 대해 묻기" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (isComposing(e) || !enterSends(e)) return;
              e.preventDefault();
              void ask();
            }} />
          <GlassButton variant="primary" size="s" disabled={asking || !draft.trim()} onClick={() => void ask()}>{asking ? "답 받는 중" : "묻기"}</GlassButton>
        </div>
      </div>
    </section>
  );
}
