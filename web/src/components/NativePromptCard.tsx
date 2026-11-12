// 대화의 '답을 기다림' 카드: 직원 CLI 가 띄운 질문·선택·승인 창을 터미널에 들어가지 않고 여기서 답한다.
// 새 업무 지시가 아니다(입력칸·멈춤과 다르다): 고른 답은 대기열을 거치지 않고 지금 그 창에 한 번 들어간다.
// 카드는 창이 뜬 순간의 귀속(직원·세션 세대·실행·작업·창 차례)을 고정하고, 서버는 누를 때 지금 것과 같은지 다시 본다.
// 같은 창에 두 번 넣지 않는다: 누른 답의 operationId 를 이 탭에 적어 두고, 새로고침·응답 유실 뒤에는 같은 id 로 결과만 다시 받는다.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Member, NativeAnswerReceipt, NativePromptOption, NativePromptState, Task } from "@shared/types";
import { GlassButton, cx } from "../glass";
import { ApiError, api, errorText } from "../lib/api";
import { useAutoGrow } from "./Composer";
import { Badge, CONFIRM_MIN_MS } from "./ui";
import { dismissAnswer, lastAnswer, noteAnswer } from "../lib/nativeAnswers";
import "../styles/approval.css";

const KIND_LABEL = { permission: "권한 승인", question: "질문", menu: "선택", setup: "시작 설정", unknown: "창" } as const;
const PROVIDER_LABEL = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" } as const;
/** 이번 한 번이 아니라 이후에도 적용되는 선택지 */
const PERSISTS = /always allow|don'?t ask again|for this session|in this conversation|persist|auto mode|remember this choice/i;
/** 누른 뒤 다음 창이 바로 뜰 수 있다. 이만큼 뒤에 한 번 다시 읽는다. */
const REREAD_AFTER_SEND_MS = 1500;
const TEXT_MAX = 4000;
const STORE_KEY = (memberId: string) => `iamceo.nativeAnswer.${memberId}`;

interface Pending { promptId: string; operationId: string; option: number; text?: string }

function loadPending(memberId: string): Pending | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY(memberId));
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}
function savePending(memberId: string, p: Pending | null): void {
  try {
    if (p) sessionStorage.setItem(STORE_KEY(memberId), JSON.stringify(p));
    else sessionStorage.removeItem(STORE_KEY(memberId));
  } catch {
    /* 저장이 안 되는 탭: 서버의 창 울타리가 두 번째 입력을 막는다 */
  }
}
const newOperationId = () => `na-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const RESULT_TONE: Record<NativeAnswerReceipt["status"], "ok" | "warn" | "danger"> = {
  answered: "ok", already_answered: "warn", changed: "warn", stale: "warn", busy: "warn", gone: "danger", unsupported: "danger",
};

export default function NativePromptCard({ member, tasks }: { member: Member; tasks: readonly Task[] }) {
  /** undefined: 읽는 중 */
  const [state, setState] = useState<NativePromptState | undefined>(undefined);
  const [readError, setReadError] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NativeAnswerReceipt | null>(() => lastAnswer(member.id));
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const pickedAt = useRef(0);
  const seq = useRef(0);
  const shownPrompt = useRef<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(textRef, text);

  const send = useCallback(async (p: Pending, ctx: NonNullable<NativePromptState["context"]>) => {
    busyRef.current = true;
    setBusy(true);
    setError(null);
    savePending(member.id, p);
    try {
      const r = await api.answerNativePrompt(member.id, { operationId: p.operationId, promptId: p.promptId, generation: ctx.generation, executionId: ctx.executionId, option: p.option, ...(p.text ? { text: p.text } : {}) });
      savePending(member.id, null);
      setResult(r);
      noteAnswer(member.id, r);
      setPick(null);
      if (r.status === "answered") setText("");
    } catch (e) {
      // 응답을 잃었을 수 있다. 같은 operationId 로만 다시 묻는다(새로 넣지 않는다).
      setError(`${errorText(e)}${e instanceof ApiError && e.status >= 400 && e.status < 500 ? "" : " · 다시 읽기를 누르면 같은 답의 결과만 받아 옵니다(새로 넣지 않음)"}`);
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) savePending(member.id, null);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [member.id]);

  const read = useCallback(async () => {
    const token = ++seq.current;
    try {
      const next = await api.nativePrompt(member.id);
      if (token !== seq.current) return;
      const id = next.context?.promptId ?? null;
      if (id !== shownPrompt.current) {
        // 다른 창이면 고른 것을 지운다. 번호가 같아도 뜻이 다를 수 있다.
        setPick(null);
        setText("");
        if (id && lastAnswer(member.id)?.promptId !== id) { setResult(null); dismissAnswer(member.id); }
      }
      shownPrompt.current = id;
      setState(next);
      setReadError(null);
      // 새로고침·응답 유실 뒤: 이 창에 보낸 답이 남아 있으면 같은 id 로 결과만 다시 받는다.
      const pending = loadPending(member.id);
      if (pending && next.context && pending.promptId === next.context.promptId && !busyRef.current) void send(pending, next.context);
    } catch (e) {
      if (token !== seq.current) return;
      setReadError(errorText(e));
      setState((s) => s ?? { prompt: null, context: null });
    }
  }, [member.id, send]);

  useEffect(() => {
    if (!busyRef.current) void read();
  }, [read, member.updatedAt, member.status]);
  useEffect(() => () => { seq.current++; }, []);
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => void read(), REREAD_AFTER_SEND_MS);
    return () => clearTimeout(t);
  }, [result, read]);

  const prompt = state?.prompt ?? null;
  const ctx = state?.context ?? null;
  const option: NativePromptOption | null = prompt?.options.find((o) => o.n === pick) ?? null;
  const task = ctx?.taskId ? tasks.find((t) => t.id === ctx.taskId) ?? null : null;

  const choose = (n: number | null) => {
    pickedAt.current = Date.now();
    setError(null);
    setPick(n);
  };

  const confirm = () => {
    if (!prompt || !ctx || !option || busyRef.current) return;
    if (Date.now() - pickedAt.current < CONFIRM_MIN_MS) return; // 고른 직후 두 번째 탭은 확인으로 받지 않는다
    const body = option.freeText ? text.trim() : undefined;
    if (option.freeText && !body) {
      setError("보낼 글을 적어 주세요");
      return;
    }
    const pending = loadPending(member.id);
    const reuse = pending && pending.promptId === ctx.promptId && pending.option === option.n && pending.text === body ? pending : null;
    void send(reuse ?? { promptId: ctx.promptId, operationId: newOperationId(), option: option.n, ...(body ? { text: body } : {}) }, ctx);
  };

  const head = (
    <div className="npc-head">
      <p className="npc-who">
        <b>{member.name}</b>
        {prompt ? `이(가) ${KIND_LABEL[prompt.kind]}에 답을 기다립니다` : "이(가) 멈춰 있습니다"}
      </p>
      <div className="npc-tags">
        {prompt ? <Badge tone="neutral">{PROVIDER_LABEL[prompt.provider]}</Badge> : null}
        <Badge tone="neutral">{task ? `작업: ${task.title}` : "작업: 전체"}</Badge>
        <GlassButton variant="ghost" size="s" className="apv-reread" disabled={busy} onClick={() => void read()}>
          다시 읽기
        </GlassButton>
      </div>
    </div>
  );

  const resultLine = result ? (
    <p className={cx("npc-result", `npc-result--${RESULT_TONE[result.status]}`)} role="status">
      {result.status === "answered" ? "답했습니다 · " : result.status === "already_answered" ? "이미 답한 창 · " : ""}
      {result.note}
    </p>
  ) : null;

  if (state === undefined) {
    return (
      <section className="npc" aria-busy="true">
        {head}
        <p className="apv-wait">창을 읽는 중입니다</p>
      </section>
    );
  }

  if (!prompt || !ctx) {
    return (
      <section className="npc">
        {head}
        {resultLine}
        <p className="apv-wait">{readError ? `창을 읽지 못했습니다: ${readError}` : result ? "창이 닫혔습니다. 직원이 이어서 일합니다." : "여기서 읽을 수 있는 창이 없습니다. 팀 화면의 터미널 화면을 확인하세요."}</p>
        {result ? (
          <div className="apv-foot">
            <GlassButton variant="ghost" size="s" onClick={() => dismissAnswer(member.id)}>
              닫기
            </GlassButton>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="npc" aria-label={`${member.name}의 ${KIND_LABEL[prompt.kind]}`}>
      {head}
      <p className="npc-hint">이 창에 바로 답합니다. 새 업무 지시가 아니며 입력칸·멈춤과 따로 갑니다.</p>
      {prompt.title ? <h3 className="apv-title">{prompt.title}</h3> : null}
      {prompt.body ? (
        <pre className="apv-body t-code" tabIndex={0} aria-label="창 내용">
          {prompt.body}
        </pre>
      ) : null}
      {prompt.question ? <p className="apv-question">{prompt.question}</p> : null}
      {resultLine}
      {error ? (
        <p className="apv-error" role="alert">
          {error}
        </p>
      ) : null}

      {prompt.limited ? (
        <>
          <p className="apv-error">선택지를 확실히 읽지 못해 여기서는 답하지 않습니다({prompt.limitedReason ?? "모양을 모름"}). 아래 화면 원문을 보고 터미널에서 답하세요.</p>
          <pre className="apv-body t-code" tabIndex={0} aria-label="화면 원문">
            {prompt.raw}
          </pre>
        </>
      ) : (
        <>
          <div className="apv-opts" role="group" aria-label="선택지">
            {prompt.options.map((o, i) => (
              <button key={o.n} type="button" className="apv-opt" data-reject={o.reject ? "" : undefined} aria-pressed={pick === o.n} disabled={busy} onClick={() => choose(pick === o.n ? null : o.n)}>
                <span className="apv-opt__n t-tabular">{o.n}.</span>
                <span className="apv-opt__main">
                  <span className="apv-opt__label">{o.label}</span>
                  {o.detail ? <span className="npc-opt__detail">{o.detail}</span> : null}
                  <span className="apv-opt__tags">
                    {o.reject ? <Badge tone="danger">거절</Badge> : null}
                    {o.freeText ? <Badge tone="neutral">직접 입력</Badge> : null}
                    {!o.reject && PERSISTS.test(o.label) ? <span className="apv-opt__persist">이후에도 적용</span> : null}
                    {i === prompt.selected ? <span className="apv-opt__persist">지금 커서</span> : null}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {option?.freeText ? (
            <label className="apv-note">
              <span className="apv-note__label">보낼 답</span>
              <textarea ref={textRef} className="input apv-note__input" rows={1} maxLength={TEXT_MAX} value={text} disabled={busy} placeholder="이 질문에 보낼 답(보내면 바로 제출됩니다)" onChange={(e) => setText(e.target.value)} />
            </label>
          ) : null}
          {option ? (
            <div className="apv-confirm">
              <p className="apv-confirm__hint">
                {option.freeText ? "적은 글을 이 질문의 답으로 한 번 보냅니다." : option.reject ? "이 창에서 거절을 고릅니다." : PERSISTS.test(option.label) ? "이 선택지를 고릅니다. 이번 한 번이 아니라 이후에도 적용됩니다." : "이 선택지를 고릅니다."}
              </p>
              <div className="apv-confirm__row">
                <GlassButton variant="primary" size="m" className="apv-confirm__go" disabled={busy} onClick={confirm}>
                  {busy ? "보내는 중" : option.freeText ? "답 보내기" : option.reject ? "거절 확인" : "이것으로 답하기"}
                </GlassButton>
                <GlassButton variant="ghost" size="m" disabled={busy} onClick={() => choose(null)}>
                  취소
                </GlassButton>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
