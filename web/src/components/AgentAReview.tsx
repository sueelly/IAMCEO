// Agent-A 문서를 IAMCEO 화면 안에서 바로 쓴다: 문장 끌어 댓글 · 답글 · 전체 댓글 · 그림 영역 질문 · 수정안 저장 · 판 · 문서 관리.
// Agent-A 앱을 칸(iframe)에 넣지 않는다. 본문·댓글·수정안은 IAMCEO 서버의 검토 길(/api/agent-a/docs/:id/review…)로만 받고,
// 화면은 IAMCEO 공통 부품(버튼·배지·팝업·마크다운)으로 그린다. 문서 글은 IAMCEO 의 마크다운 보기가 걸러 그리므로 스크립트가 돌지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentAProjectInfo, AgentAReviewComments, AgentAReviewDoc, AgentAReviewImageRegion, AgentAReviewProposal, AgentAReviewVersion } from "@shared/agent-a";
import { api, errorText } from "../lib/api";
import { buildThreads, myTurn, outline } from "../lib/agent-a-review";
import { newId } from "../lib/store";
import { AgentAManage } from "./agent-a/AgentAManage";
import { CommentPanel, type PanelView } from "./agent-a/CommentPanel";
import { ReviewDocument } from "./agent-a/ReviewDocument";
import { Badge, MQ_DESKTOP, Modal, Sheet, Time, useMediaQuery } from "./ui";
import "../styles/agent-a.css";

/** 답을 쓰는 중이면 자주, 아니면 드물게 댓글을 다시 읽는다. */
const POLL_BUSY_MS = 1_200;
const POLL_IDLE_MS = 5_000;
/** 정본이 다른 곳에서 바뀌었는지 보는 간격. */
const FRESH_MS = 20_000;

function readJson<T>(storage: () => Storage, key: string, fallback: T): T {
  try {
    const v = JSON.parse(storage().getItem(key) ?? "null") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(storage: () => Storage, key: string, value: unknown): void {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    // 저장소를 못 쓰는 브라우저 설정이면 이 창에서만 기억한다
  }
}

export function AgentAReview({ fileId, title, info }: { fileId: string; title: string; info: AgentAProjectInfo }) {
  const desktop = useMediaQuery(MQ_DESKTOP);
  const unseen = info.docs.find((d) => d.fileId === fileId)?.unseen ?? 0;
  // 이 자료를 열어 두었으면 알린 답을 읽은 것으로 둔다(목록의 '새 답'이 사라진다).
  useEffect(() => {
    void api.agentARead(fileId).catch(() => {});
  }, [fileId, unseen]);

  /** 과거 판의 검토를 다시 연 것이면 그 검토 id. 없으면 지금 정본. */
  const [resume, setResume] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [doc, setDoc] = useState<AgentAReviewDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 보는 사이 정본이 바뀌었다(다른 화면·수정안 저장). */
  const [newer, setNewer] = useState(false);
  /** 과거 판의 본문만 보는 중. */
  const [past, setPast] = useState<{ version: number; markdown: string } | null>(null);
  const [comments, setComments] = useState<AgentAReviewComments | null>(null);
  const [proposals, setProposals] = useState<AgentAReviewProposal[]>([]);
  const [view, setView] = useState<PanelView>({ kind: "list" });
  const [panelOpen, setPanelOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [versions, setVersions] = useState<AgentAReviewVersion[] | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shownSession = useRef<string | null>(null);

  // 데스크톱은 댓글 칸을 편 채로, 폰은 접은 채로 시작한다(본문이 먼저 보이게).
  const [panelFor, setPanelFor] = useState<boolean | null>(null);
  if (panelFor !== desktop) {
    setPanelFor(desktop);
    setPanelOpen(desktop);
  }

  // ---- 문서 열기 ----
  const usable = info.ui;
  useEffect(() => {
    // 연결을 쓸 수 없으면(닿지 않음·열쇠 없음) 부르지 않는다. 까닭은 아래에서 보인다
    if (!usable) return;
    const abort = new AbortController();
    setLoadError(null);
    api.agentAReview.open(fileId, resume, abort.signal).then(
      (next) => {
        // 다른 검토(다른 판)로 바뀌면 앞 검토의 댓글을 보이지 않는다
        if (shownSession.current !== next.sessionId) {
          shownSession.current = next.sessionId;
          setComments(null);
          setProposals([]);
          setView({ kind: "list" });
        }
        setDoc(next);
        setNewer(false);
        setPast(null);
      },
      (e) => !abort.signal.aborted && setLoadError(errorText(e)),
    );
    return () => abort.abort();
  }, [fileId, resume, reload, usable]);

  const sessionId = doc?.sessionId ?? null;
  const latest = doc?.latest ?? false;

  // 지금 정본을 보는 동안, 다른 곳에서 정본이 바뀌면 알린다(자동으로 본문을 바꾸지 않는다: 쓰던 글·읽던 자리를 지킨다).
  useEffect(() => {
    if (!sessionId || !latest || resume) return;
    let stopped = false;
    const check = () => {
      if (document.visibilityState === "hidden") return;
      api.agentAReview.open(fileId).then((next) => !stopped && next.sessionId !== sessionId && setNewer(true), () => {});
    };
    const timer = setInterval(check, FRESH_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [fileId, sessionId, latest, resume]);

  // ---- 댓글·수정안 다시 읽기 ----
  const writing = useRef(false);
  const poke = useRef<() => void>(() => {});
  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let since: number | null = null;
    let running = false;
    const loadProposals = () => api.agentAReview.proposals(fileId, sessionId).then((p) => !stopped && setProposals(p), () => {});
    const tick = async () => {
      if (running) return;
      running = true;
      if (timer) clearTimeout(timer);
      if (document.visibilityState !== "hidden") {
        try {
          const next = await api.agentAReview.comments(fileId, sessionId, since);
          if (stopped) return;
          if (next) {
            since = next.version;
            setComments(next);
            void loadProposals();
          }
        } catch (e) {
          if (!stopped && since === null) setError(errorText(e));
        }
      }
      running = false;
      if (!stopped) timer = setTimeout(() => void tick(), writing.current ? POLL_BUSY_MS : POLL_IDLE_MS);
    };
    poke.current = () => void tick();
    void tick();
    const onVisible = () => document.visibilityState === "visible" && void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      poke.current = () => {};
    };
  }, [fileId, sessionId]);

  const threads = useMemo(() => buildThreads(comments?.annotations ?? [], proposals), [comments, proposals]);
  writing.current = threads.some((t) => t.writing);

  // ---- 내 차례(읽은 답)와 쓰던 글: 이 기기 브라우저에만 둔다 ----
  const readKey = `iamceo.agentA.read.${fileId}`;
  const [read, setRead] = useState<Record<string, string>>(() => readJson(() => localStorage, readKey, {}));
  const draftKey = `iamceo.agentA.drafts.${fileId}`;
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readJson(() => sessionStorage, draftKey, {}));
  const setDraft = useCallback((key: string, text: string) => {
    setDrafts((cur) => {
      const next = { ...cur, [key]: text };
      if (!text) delete next[key];
      writeJson(() => sessionStorage, draftKey, next);
      return next;
    });
  }, [draftKey]);
  const turn = useMemo(() => myTurn(threads, read), [threads, read]);
  const openThread = view.kind === "thread" && panelOpen ? view.id : null;
  // 댓글을 열어 보면 그 댓글의 마지막 답을 읽은 것으로 둔다
  useEffect(() => {
    if (!openThread) return;
    const mine = turn.filter((t) => t.threadId === openThread);
    if (!mine.length) return;
    setRead((cur) => {
      const next = { ...cur };
      for (const t of mine) next[t.answerId] = t.text;
      writeJson(() => localStorage, readKey, next);
      return next;
    });
  }, [openThread, turn, readKey]);

  // ---- 일 ----
  const act = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  // 같은 새 댓글을 다시 보내도(응답을 못 받았을 때) 댓글은 하나다: 보낼 때까지 같은 id 를 쓴다.
  const pendingId = useRef<{ key: string; id: string } | null>(null);
  const show = (next: PanelView) => {
    setError(null);
    setView(next);
    setPanelOpen(true);
  };
  const toLatest = (message?: string) => {
    setNotice(message ?? null);
    setResume(null);
    setReload((n) => n + 1);
  };
  const regionDraft: AgentAReviewImageRegion | null = view.kind === "new" && view.target.kind === "region" && panelOpen ? view.target.region : null;

  if (!info.ui) return <p className="aa-warn" role="status">{info.uiBlocked ?? "Agent-A 문서를 열 수 없습니다"}</p>;
  if (loadError && !doc) {
    return (
      <p className="aa-warn" role="status">
        Agent-A 문서를 열지 못했습니다: {loadError}{" "}
        <button type="button" className="aa-link" onClick={() => setReload((n) => n + 1)}>
          다시 열기
        </button>
      </p>
    );
  }
  if (!doc || !sessionId) return <p className="fl-wait" role="status">문서를 여는 중…</p>;

  const blocked = past ? "과거 판의 본문만 보는 중입니다. 댓글은 ‘지금 정본 보기’로 돌아가서 답니다." : doc.closed ? "제출로 닫힌 검토입니다. ‘지금 정본 보기’에서 새 댓글을 답니다." : !doc.latest ? "과거 판의 검토입니다. 답글은 이 판의 댓글에 남고, 새 댓글은 ‘지금 정본 보기’에서 답니다." : null;
  const replyBlocked = past ? blocked : null;
  const markdown = past?.markdown ?? doc.markdown;
  const toc = outline(markdown);
  const jump = (index: number) => {
    scrollRef.current?.querySelectorAll<HTMLElement>(".aar-md h1, .aar-md h2, .aar-md h3")[index]?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (!desktop) setTocOpen(false);
  };
  const tocList = toc.length ? (
    <ol className="aar-toc__list">
      {toc.map((h) => (
        <li key={h.index} data-level={h.level}>
          <button type="button" onClick={() => jump(h.index)}>{h.text}</button>
        </li>
      ))}
    </ol>
  ) : (
    <p className="aar-note">머리말이 없는 문서입니다.</p>
  );

  const panel = (
    <CommentPanel
      view={view}
      threads={past ? [] : threads}
      turn={past ? [] : turn}
      loading={comments === null}
      blocked={view.kind === "thread" ? replyBlocked : blocked}
      busy={busy}
      error={error}
      draftOf={(key) => drafts[key] ?? ""}
      setDraft={setDraft}
      onView={(next) => { setError(null); setView(next); }}
      onCreate={(target, text) => void act(async () => {
        const key = target.kind === "global" ? "new:global" : target.kind === "region" ? "new:region" : "new:quote";
        if (pendingId.current?.key !== `${key}\n${text}`) pendingId.current = { key: `${key}\n${text}`, id: newId() };
        const id = pendingId.current.id;
        await api.agentAReview.addComment(fileId, sessionId, { id, kind: target.kind === "global" ? "global" : "comment", text, quote: target.kind === "quote" ? target.quote : "", region: target.kind === "region" ? target.region : null });
        pendingId.current = null;
        setDraft(key, "");
        window.getSelection()?.removeAllRanges();
        setView({ kind: "thread", id });
        poke.current();
      })}
      onReply={(threadId, text) => void act(async () => {
        await api.agentAReview.reply(fileId, sessionId, threadId, text);
        setDraft(`reply:${threadId}`, "");
        poke.current();
      })}
      onResolve={(threadId, resolved) => void act(async () => {
        await api.agentAReview.resolve(fileId, sessionId, threadId, resolved);
        poke.current();
      })}
      onRemove={(id) => void act(async () => {
        await api.agentAReview.remove(fileId, sessionId, id);
        setView({ kind: "list" });
        poke.current();
      })}
      onRetry={(answerId) => void act(async () => {
        await api.agentAReview.retry(fileId, sessionId, answerId);
        poke.current();
      })}
      onFork={(threadId) => void act(async () => {
        const r = await api.agentAReview.fork(fileId, sessionId, threadId);
        setView({ kind: "thread", id: r.id });
        poke.current();
      })}
      onApprove={(p) => void act(async () => {
        const r = await api.agentAReview.approve(fileId, sessionId, p.annotationId, p.proposalId);
        // 정본이 바뀌었다. 새 본문을 연다. 이 댓글은 쓴 때의 판에 남고 '판'에서 다시 열 수 있다.
        toLatest(r.verified ? `수정안을 정본에 저장했습니다(판 ${r.artifactRevision}). 새 본문을 열었습니다.` : `저장은 됐지만 정본 본문 확인이 맞지 않습니다(판 ${r.artifactRevision}).`);
      })}
    />
  );

  const openVersions = () => {
    setVersionsOpen(true);
    api.agentAReview.versions(fileId, sessionId).then(setVersions, (e) => setError(errorText(e)));
  };
  const historical = comments?.historical ?? [];

  return (
    <div className="aar" data-panel={desktop && panelOpen ? "" : undefined} data-toc={desktop && tocOpen ? "" : undefined} data-session={sessionId}>
      <div className="aar-bar" role="toolbar" aria-label="Agent-A 문서 도구">
        <button type="button" className="vw-btn" aria-expanded={tocOpen} onClick={() => setTocOpen((v) => !v)}>목차</button>
        <button type="button" className="vw-btn" onClick={openVersions}>판</button>
        <button type="button" className="vw-btn" onClick={() => setManageOpen(true)}>
          문서 관리{doc.recoveries.length ? <span className="aar-bar__count t-tabular">{doc.recoveries.length}</span> : null}
        </button>
        <span className="aar-bar__state">{past ? `과거 판 ${past.version}` : doc.latest ? (doc.artifactRevision ? `정본 판 ${doc.artifactRevision}` : "지금 정본") : "과거 판의 검토"}{doc.edited && !past ? " · 직접 편집 초안" : ""}</span>
        <button type="button" className="vw-btn aar-bar__comments" aria-expanded={panelOpen} onClick={() => setPanelOpen((v) => !v)}>
          댓글 <span className="t-tabular">{threads.length}</span>
          {turn.length ? <Badge tone="accent">{turn.length}</Badge> : null}
        </button>
      </div>
      {notice ? (
        <p className="aar-banner" role="status">
          <span>{notice}</span>
          <button type="button" className="aa-link" onClick={() => setNotice(null)}>닫기</button>
        </p>
      ) : null}
      {past || !doc.latest ? (
        <p className="aar-banner" role="status">
          <span>{past ? `과거 판 ${past.version}의 본문입니다.` : "과거 판의 검토를 보고 있습니다. 본문과 댓글은 그때 것입니다."}</span>
          <button type="button" className="aa-link" onClick={() => (past && doc.latest ? setPast(null) : toLatest())}>지금 정본 보기</button>
        </p>
      ) : newer ? (
        <p className="aar-banner" role="status">
          <span>정본이 바뀌었습니다. 보던 본문은 그대로 두었습니다.</span>
          <button type="button" className="aa-link" onClick={() => toLatest()}>새 본문 보기</button>
        </p>
      ) : null}
      {!past && historical.length ? (
        <p className="aar-banner" data-quiet="" role="status">
          <span>다른 판에 남은 댓글이 {historical.reduce((n, h) => n + h.count, 0)}개 있습니다.</span>
          <button type="button" className="aa-link" onClick={openVersions}>판에서 보기</button>
        </p>
      ) : null}
      <div className="aar-body">
        {desktop && tocOpen ? <nav className="aar-toc" aria-label="목차">{tocList}</nav> : null}
        <div ref={scrollRef} className="aar-scroll">
          <ReviewDocument
            fileId={fileId}
            session={sessionId}
            markdown={markdown}
            images={past ? [] : doc.images}
            threads={past ? [] : threads}
            activeThread={openThread}
            canComment={blocked === null}
            regionDraft={regionDraft}
            onQuote={(quote) => show({ kind: "new", target: { kind: "quote", quote } })}
            onRegion={(region) => show({ kind: "new", target: { kind: "region", region } })}
            onOpenThread={(id) => show({ kind: "thread", id })}
          />
        </div>
        {desktop && panelOpen ? <aside className="aar-side">{panel}</aside> : null}
      </div>
      {desktop ? null : (
        <>
          <Sheet open={panelOpen} onClose={() => setPanelOpen(false)} title={`‘${title}’ 댓글`}>{panel}</Sheet>
          <Sheet open={tocOpen} onClose={() => setTocOpen(false)} title="목차">{tocList}</Sheet>
        </>
      )}
      <Modal open={versionsOpen} onClose={() => setVersionsOpen(false)} title="판">
        <div className="aar-manage">
          <p className="aar-note">본문이 달랐던 때마다 판 하나입니다. 과거 판은 읽기만 하고, 그 판에 단 댓글은 그 판에서 엽니다.</p>
          {versions === null ? <p className="aar-note" role="status">판을 불러오는 중…</p> : (
            <ol className="aar-versions" aria-label="검토 판">
              {[...versions].reverse().map((v, i) => (
                <li key={v.version}>
                  <span className="t-tabular">판 {v.version}</span>
                  <Time iso={v.at} />
                  {i === 0 && doc.latest ? <Badge tone="ok">지금 보는 정본</Badge> : (
                    <button type="button" className="vw-btn" onClick={() => {
                      api.agentAReview.version(fileId, sessionId, v.version).then((got) => { setPast(got); setVersionsOpen(false); setView({ kind: "list" }); }, (e) => setError(errorText(e)));
                    }}>본문 보기</button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {historical.length ? (
            <>
              <p className="aar-note">다른 판에 남은 댓글</p>
              <ul className="aar-versions" aria-label="다른 판의 댓글">
                {historical.map((h) => {
                  const known = doc.recoveries.find((r) => r.sessionId === h.sessionId);
                  return (
                    <li key={h.sessionId}>
                      <span>댓글 <span className="t-tabular">{h.count}</span>개{known?.artifactRevision ? ` · 정본 판 ${known.artifactRevision}` : ""}</span>
                      {known ? <Time iso={known.createdAt} /> : null}
                      <button type="button" className="vw-btn" onClick={() => { setResume(h.sessionId); setVersionsOpen(false); }}>그 판에서 열기</button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          {error ? <p className="aar-error" role="alert">{error}</p> : null}
        </div>
      </Modal>
      <AgentAManage fileId={fileId} open={manageOpen} recoveries={doc.recoveries} onClose={() => setManageOpen(false)} onChanged={(message) => toLatest(message)} onOpenReview={(id) => setResume(id)} />
    </div>
  );
}
