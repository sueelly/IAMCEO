// Agent-A 문서를 IAMCEO 화면 안에서 바로 쓴다: 문장 끌어 댓글 · 요소 지정 · 삭제 표시 · 답글 · 전체 댓글 · 그림 영역 질문 · 그림 붙이기 · AI 고르기 ·
// 문서에 묻기 · 본문 직접 고치기(초안) · 검토 제출 · 수정안 저장 · 판 · 문서 관리.
// Agent-A 앱을 칸(iframe)에 넣지 않는다. 본문·댓글·수정안은 IAMCEO 서버의 검토 길(/api/agent-a/docs/:id/review…)로만 받고,
// 화면은 IAMCEO 공통 부품(버튼·배지·팝업·마크다운)으로 그린다. 문서 글은 IAMCEO 의 마크다운 보기가 걸러 그리므로 스크립트가 돌지 않는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentAProjectInfo, AgentAReviewAiCatalog, AgentAReviewAiSettings, AgentAReviewAttachment, AgentAReviewComments, AgentAReviewDoc, AgentAReviewDraft, AgentAReviewImageRegion, AgentAReviewProposal, AgentAReviewVersion } from "@shared/agent-a";
import { GlassButton } from "../glass";
import { ApiError, api, errorText } from "../lib/api";
import { THUMBS_UP, labelText, loadLabels, saveLabels, type QuickLabel } from "../lib/agent-a-labels";
import { buildThreads, myTurn, outline } from "../lib/agent-a-review";
import { newId } from "../lib/store";
import { AgentAManage } from "./agent-a/AgentAManage";
import { ChatPanel } from "./agent-a/ChatPanel";
import { CommentPanel, type PanelView } from "./agent-a/CommentPanel";
import { DraftEditor } from "./agent-a/DraftEditor";
import { ImageDraw } from "./agent-a/ImageDraw";
import { LabelEditor } from "./agent-a/LabelEditor";
import { ReviewAttachments, uploadImage } from "./agent-a/ReviewAttachments";
import { ReviewDocument, type DiagramDraft, type ReviewInput, type ReviewMode } from "./agent-a/ReviewDocument";
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

const MODES: { key: ReviewMode; label: string; hint: string }[] = [
  { key: "markup", label: "표시", hint: "고른 뒤 댓글·삭제 표시·묻기 중에 고릅니다" },
  { key: "comment", label: "댓글", hint: "고르면 바로 댓글을 씁니다" },
  { key: "redline", label: "삭제 표시", hint: "고르면 바로 삭제 표시를 남깁니다" },
  { key: "label", label: "라벨", hint: "고르면 바로 빠른 라벨 목록을 띄웁니다" },
];
const INPUTS: { key: ReviewInput; label: string; hint: string }[] = [
  { key: "drag", label: "끌기", hint: "글을 끌어 고릅니다" },
  { key: "pinpoint", label: "요소 지정", hint: "문단·항목·제목을 눌러 통째로 고릅니다" },
];
export function AgentAReview({ fileId, projectId, title, info }: { fileId: string; projectId: string; title: string; info: AgentAProjectInfo }) {
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
  // 고르는 방법과 고른 뒤 동작, 답에 쓸 AI: 이 기기 브라우저에 기억한다.
  const [tool, setTool] = useState<{ mode: ReviewMode; input: ReviewInput }>(() => {
    const saved = readJson<{ mode?: string; input?: string }>(() => localStorage, "iamceo.agentA.tool", {});
    return { mode: MODES.some((m) => m.key === saved.mode) ? (saved.mode as ReviewMode) : "markup", input: saved.input === "pinpoint" ? "pinpoint" : "drag" };
  });
  const pickTool = (next: { mode: ReviewMode; input: ReviewInput }) => {
    setTool(next);
    writeJson(() => localStorage, "iamceo.agentA.tool", next);
  };
  const [ai, setAiState] = useState<AgentAReviewAiSettings>(() => readJson(() => localStorage, "iamceo.agentA.ai", {}));
  const setAi = (next: AgentAReviewAiSettings) => {
    setAiState(next);
    writeJson(() => localStorage, "iamceo.agentA.ai", next);
  };
  const [catalog, setCatalog] = useState<AgentAReviewAiCatalog | null>(null);
  // 빠른 라벨: 이 기기 브라우저에 기억한 목록.
  const [labels, setLabels] = useState<QuickLabel[]>(() => loadLabels());
  const [labelsOpen, setLabelsOpen] = useState(false);
  /** 검토 전체에 붙인 그림(초안). 창을 열어 읽기 전에는 수를 모른다(null). */
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachCount, setAttachCount] = useState<number | null>(null);
  /** 새 댓글에 붙일 그림 가운데 지금 그리는 것. */
  const [drawing, setDrawing] = useState<{ path: string; url: string; name: string } | null>(null);
  /** 새 댓글에 붙이려고 올려 둔 그림. */
  const [images, setImages] = useState<AgentAReviewAttachment[]>([]);
  /** 올려 둔 그림의 미리 보기(이 브라우저 안의 주소). 화면을 떠날 때 놓아 준다. */
  const previews = useRef(new Map<string, string>());
  useEffect(() => () => {
    for (const url of previews.current.values()) URL.revokeObjectURL(url);
  }, []);
  /** '묻기'로 고른 글(문서에 묻기의 다음 질문에 싣는다). */
  const [chatQuote, setChatQuote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /** 검토 제출 확인 창: 지금 초안. */
  const [submitDraft, setSubmitDraft] = useState<AgentAReviewDraft | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
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
          setImages([]);
          setEditing(false);
          setAttachCount(null);
          setAttachOpen(false);
          setDrawing(null);
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

  // 답에 쓸 AI 목록. 못 읽으면 고르는 칸만 보이지 않는다(댓글은 기본값으로 간다).
  useEffect(() => {
    if (!sessionId) return;
    const abort = new AbortController();
    api.agentAReview.ai(fileId, sessionId, abort.signal).then(setCatalog, () => !abort.signal.aborted && setCatalog(null));
    return () => abort.abort();
  }, [fileId, sessionId]);

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
  const diagramDraft: DiagramDraft | null = view.kind === "new" && view.target.kind === "diagram" && panelOpen ? view.target : null;

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

  const blocked = past ? "과거 판의 본문만 보는 중입니다. 댓글은 ‘지금 정본 보기’로 돌아가서 답니다." : doc.closed ? "제출로 닫힌 검토입니다. ‘지금 정본 보기’에서 새 댓글을 답니다." : !doc.latest ? "과거 판의 검토입니다. 답글은 이 판의 댓글에 남고, 새 댓글은 ‘지금 정본 보기’에서 답니다."
    : !doc.safeWrites ? "이 Agent-A 는 초안 보존 규약을 몰라 새 댓글·삭제 표시·본문 고치기·검토 제출을 막았습니다. 읽기·답글·수정안 저장은 그대로 됩니다." : null;
  const canWrite = blocked === null;
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
      catalog={catalog}
      ai={ai}
      onAi={setAi}
      images={images}
      imageUrl={(path) => api.agentAReview.attachmentUrl(fileId, sessionId, path)}
      imagePreview={(path) => previews.current.get(path) ?? null}
      onAttach={(file) => void act(async () => {
        const up = await uploadImage(fileId, sessionId, file);
        if (!previews.current.has(up.path)) previews.current.set(up.path, URL.createObjectURL(file));
        setImages((cur) => (cur.some((x) => x.path === up.path) ? cur : [...cur, up]));
      })}
      onDrawImage={(path) => {
        const url = previews.current.get(path), image = images.find((x) => x.path === path);
        if (!url || !image) return setError("이 그림은 다시 붙인 뒤에 그릴 수 있습니다");
        setError(null);
        setDrawing({ path, url, name: image.name });
      }}
      labels={labels}
      onDetach={(path) => setImages((cur) => cur.filter((x) => x.path !== path))}
      onCreate={(target, text) => void act(async () => {
        const key = target.kind === "global" ? "new:global" : target.kind === "region" ? "new:region" : target.kind === "diagram" ? "new:diagram" : "new:quote";
        // 같은 글·같은 그림·같은 AI 설정이면 같은 id 로 다시 보낸다(내용이 달라지면 새 댓글이다). 도식 댓글은 고른 자리도 같아야 한다.
        const same = `${key}\n${text}\n${images.map((x) => x.path).join(",")}\n${JSON.stringify(ai)}${target.kind === "diagram" ? `\n${JSON.stringify(target.anchor)}` : ""}`;
        if (pendingId.current?.key !== same) pendingId.current = { key: same, id: newId() };
        const id = pendingId.current.id;
        await api.agentAReview.addComment(fileId, sessionId, { id, kind: target.kind === "global" ? "global" : "comment", text, quote: target.kind === "quote" ? target.quote : "", region: target.kind === "region" ? target.region : null, diagram: target.kind === "diagram" ? target.anchor : null, images, ai });
        pendingId.current = null;
        setImages([]);
        setDraft(key, "");
        window.getSelection()?.removeAllRanges();
        setView({ kind: "thread", id });
        poke.current();
      })}
      onRegionGood={(region) => markRegionGood(region)}
      onReply={(threadId, text) => void act(async () => {
        await api.agentAReview.reply(fileId, sessionId, threadId, text, ai);
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

  // 삭제 표시: 고른 글을 지우자는 표시 하나를 남긴다(AI 답은 시작하지 않는다).
  const markDeletion = (quote: string) => void act(async () => {
    if (pendingId.current?.key !== `deletion\n${quote}`) pendingId.current = { key: `deletion\n${quote}`, id: newId() };
    const id = pendingId.current.id;
    await api.agentAReview.addComment(fileId, sessionId, { id, kind: "deletion", text: "", quote });
    pendingId.current = null;
    setNotice("삭제 표시를 남겼습니다. ‘검토 제출’ 때 함께 넘어갑니다.");
    poke.current();
  });
  // 빠른 라벨: 고른 글에 한 줄짜리 라벨을 댓글로 남긴다. 같은 글·같은 라벨을 다시 보내도 하나다.
  const markLabel = (quote: string, label: QuickLabel) => void act(async () => {
    const text = labelText(label);
    const key = `label\n${quote}\n${text}\n${label.tip ?? ""}`;
    if (pendingId.current?.key !== key) pendingId.current = { key, id: newId() };
    const id = pendingId.current.id;
    await api.agentAReview.addComment(fileId, sessionId, { id, kind: "comment", text, quote, quickLabel: { tip: label.tip ?? null } });
    pendingId.current = null;
    setNotice(`라벨 ‘${text}’을(를) 붙였습니다. ‘검토 제출’ 때 함께 넘어갑니다.`);
    poke.current();
  });
  // 그림 영역에 '좋아요' 라벨: 영역만 싣고 글은 라벨 글이다(원래 화면의 그림 영역 빠른 라벨과 같다).
  const markRegionGood = (region: AgentAReviewImageRegion) => void act(async () => {
    const text = labelText(THUMBS_UP);
    const key = `label-region\n${JSON.stringify(region)}\n${text}`;
    if (pendingId.current?.key !== key) pendingId.current = { key, id: newId() };
    const id = pendingId.current.id;
    await api.agentAReview.addComment(fileId, sessionId, { id, kind: "comment", text, quote: "", region, quickLabel: { tip: null } });
    pendingId.current = null;
    setView({ kind: "list" });
    setNotice(`라벨 ‘${text}’을(를) 붙였습니다. ‘검토 제출’ 때 함께 넘어갑니다.`);
    poke.current();
  });
  const openSubmit = () => {
    setError(null);
    setSubmitDraft(null);
    setSubmitOpen(true);
    api.agentAReview.draft(fileId, sessionId).then(setSubmitDraft, (e) => setError(errorText(e)));
  };
  // 댓글 칸 자리에 '문서에 묻기'를 보일 때는 그 칸을 통째로 바꾼다.
  const side = view.kind === "chat" ? (
    <ChatPanel fileId={fileId} session={sessionId} quote={chatQuote} onQuoteUsed={() => setChatQuote(null)} catalog={catalog} ai={ai} onAi={setAi}
      onBack={() => setView({ kind: "list" })} draft={drafts["chat"] ?? ""} setDraft={(text) => setDraft("chat", text)} />
  ) : panel;
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
        {canWrite ? (
          <>
            <button type="button" className="vw-btn" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>본문 고치기</button>
            <button type="button" className="vw-btn" onClick={openSubmit}>검토 제출</button>
            <button type="button" className="vw-btn" aria-label={attachCount ? `검토 첨부 ${attachCount}개` : "검토 첨부"} onClick={() => setAttachOpen(true)}>
              검토 첨부{attachCount ? <span className="aar-bar__count t-tabular">{attachCount}</span> : null}
            </button>
            <span className="aar-seg" role="group" aria-label="고르는 방법">
              {INPUTS.map((x) => <button key={x.key} type="button" className="aar-seg__btn" aria-pressed={tool.input === x.key} title={x.hint} onClick={() => pickTool({ ...tool, input: x.key })}>{x.label}</button>)}
            </span>
            <span className="aar-seg" role="group" aria-label="고른 뒤 동작">
              {MODES.map((x) => <button key={x.key} type="button" className="aar-seg__btn" aria-pressed={tool.mode === x.key} title={x.hint} onClick={() => pickTool({ ...tool, mode: x.key })}>{x.label}</button>)}
            </span>
          </>
        ) : null}
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
      {!past && doc.latest && !doc.closed && !doc.safeWrites ? (
        <p className="aar-banner" data-quiet="" role="status">
          <span>이 Agent-A 는 초안 보존 규약을 몰라 새 댓글·삭제 표시·본문 고치기·검토 제출을 막았습니다. 읽기·답글·수정안 저장은 그대로 됩니다.</span>
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
          {editing && canWrite ? (
            <DraftEditor fileId={fileId} session={sessionId} canonical={doc.canonical} onClose={() => setEditing(false)} onSaved={(message) => { setEditing(false); setNotice(message); setReload((n) => n + 1); }} />
          ) : (
            <ReviewDocument
              fileId={fileId}
              session={sessionId}
              markdown={markdown}
              images={past ? [] : doc.images}
              threads={past ? [] : threads}
              activeThread={openThread}
              canComment={canWrite}
              regionDraft={regionDraft}
              diagramDraft={diagramDraft}
              mode={tool.mode}
              input={tool.input}
              onQuote={(quote) => show({ kind: "new", target: { kind: "quote", quote } })}
              onDelete={markDeletion}
              onAsk={(quote) => { setChatQuote(quote); show({ kind: "chat" }); }}
              onRegion={(region) => show({ kind: "new", target: { kind: "region", region } })}
              onDiagram={(draft) => show({ kind: "new", target: { kind: "diagram", ...draft } })}
              onOpenThread={(id) => show({ kind: "thread", id })}
              labels={labels}
              onLabel={markLabel}
              onEditLabels={() => setLabelsOpen(true)}
            />
          )}
        </div>
        {desktop && panelOpen ? <aside className="aar-side">{side}</aside> : null}
      </div>
      {desktop ? null : (
        <>
          <Sheet open={panelOpen} onClose={() => setPanelOpen(false)} title={`‘${title}’ 댓글`}>{side}</Sheet>
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
      <Modal open={submitOpen} onClose={() => setSubmitOpen(false)} title="검토 제출">
        <div className="aar-manage">
          <p className="aar-note">이 판의 검토를 마칩니다. 초안에 든 댓글·삭제 표시를 ‘문서 관리 → 분기’의 질문으로 넘기고 이 검토를 닫습니다. 정본은 바뀌지 않고, 다른 수정안도 반영하지 않습니다.</p>
          {submitDraft ? (
            <p className="aar-note" role="status">
              넘길 것: 주석 <span className="t-tabular">{submitDraft.annotations}</span>개{submitDraft.editedMarkdown !== null ? " · 직접 고친 본문" : ""}{submitDraft.attachments.length ? ` · 붙인 그림 ${submitDraft.attachments.length}개` : ""}
              {submitDraft.annotations === 0 && submitDraft.editedMarkdown === null && !submitDraft.attachments.length ? " · 넘길 것이 없어 ‘확인함’으로만 닫습니다" : ""}
            </p>
          ) : error ? null : <p className="aar-note" role="status">초안을 읽는 중…</p>}
          {error ? <p className="aar-error" role="alert">{error}</p> : null}
          <p className="aar-note">‘확인하고 저장’은 이 판을 확인했다는 결정으로, ‘의견 보내기’는 고쳐 달라는 의견으로 남습니다. 주석이 분기로 넘어가는 것은 같습니다.</p>
          <div className="aar-actions">
            {(["approved", "feedback"] as const).map((decision) => (
              <GlassButton key={decision} variant={decision === "approved" ? "primary" : "glass"} size="s" disabled={busy || !submitDraft} onClick={() => void act(async () => {
                try {
                  const r = await api.agentAReview.submit(fileId, sessionId, submitDraft!.revision, decision);
                  setSubmitOpen(false);
                  toLatest(r.sent ? `검토를 제출했습니다. 질문 ${r.sent}개가 분기로 넘어갔습니다. 정본은 그대로입니다.` : "넘길 것 없이 검토를 닫았습니다. 정본은 그대로입니다.");
                } catch (e) {
                  // 그사이 다른 화면이 초안을 바꿨으면 제출하지 않고 최신 초안을 다시 보여 준다.
                  if (e instanceof ApiError && e.code === "AGENT_A_DRAFT_CONFLICT") await api.agentAReview.draft(fileId, sessionId).then(setSubmitDraft, () => {});
                  throw e;
                }
              })}>{decision === "approved" ? "확인하고 저장" : "의견 보내기"}</GlassButton>
            ))}
            <GlassButton variant="ghost" size="s" disabled={busy} onClick={() => setSubmitOpen(false)}>닫기</GlassButton>
          </div>
        </div>
      </Modal>
      <AgentAManage fileId={fileId} projectId={projectId} open={manageOpen} recoveries={doc.recoveries} onClose={() => setManageOpen(false)} onChanged={(message) => toLatest(message)} onOpenReview={(id) => setResume(id)} />
      <ReviewAttachments fileId={fileId} session={sessionId} open={attachOpen && canWrite} onClose={() => setAttachOpen(false)} onCount={setAttachCount} />
      <LabelEditor open={labelsOpen} labels={labels} onClose={() => setLabelsOpen(false)} onSave={(next) => { saveLabels(next); setLabels(loadLabels()); }} />
      {/* 새 댓글에 붙일 그림 위에 그리기: 표시한 그림을 올려 그 자리에 바꿔 끼운다. */}
      <ImageDraw source={drawing ? { url: drawing.url, name: drawing.name } : null} onClose={() => setDrawing(null)}
        onSave={async (file) => {
          if (!drawing) return false;
          try {
            const up = await uploadImage(fileId, sessionId, file);
            if (!previews.current.has(up.path)) previews.current.set(up.path, URL.createObjectURL(file));
            setImages((cur) => cur.filter((x) => x.path !== up.path || x.path === drawing.path).flatMap((x) => (x.path === drawing.path ? [up] : [x])));
            return true;
          } catch (e) {
            setError(errorText(e));
            return false;
          }
        }} />
    </div>
  );
}
