// Agent-A 검토 화면의 계산(화면 공통 규칙). 브라우저 API 를 쓰지 않는다.
// 댓글 묶기·순서는 Agent-A 원래 화면의 규칙(src/plannotator/comment-thread-order.js, MyTurn.tsx)을 따른다.
import type { AgentAReviewAnnotation, AgentAReviewImage, AgentAReviewImageRegion, AgentAReviewProposal } from "@shared/agent-a";

/** 댓글이 속한 첫 댓글 id. 부모가 목록에 없거나 고리가 있으면 닿은 데까지를 뿌리로 본다(댓글을 잃지 않는다). */
export function threadRoot(annotations: readonly Pick<AgentAReviewAnnotation, "id" | "inReplyTo">[], id: string): string {
  const byId = new Map(annotations.map((a) => [a.id, a]));
  const seen = new Set<string>();
  let cur = id;
  for (;;) {
    const parent = byId.get(cur)?.inReplyTo;
    if (!parent || !byId.has(parent)) return cur;
    if (seen.has(cur)) return [...seen].sort()[0]!;
    seen.add(cur);
    cur = parent;
  }
}

export interface ReviewThread {
  root: AgentAReviewAnnotation;
  /** 쓴 차례대로(첫 댓글 포함). */
  messages: AgentAReviewAnnotation[];
  /** 마지막으로 바뀐 때(답·고침 포함). */
  latest: number;
  /** 완료로 표시했거나 수정안을 반영한 댓글. 목록 아래로 간다. */
  done: boolean;
  writing: boolean;
  failed: boolean;
  /** 이 댓글의 답에 딸린 문서 수정안. */
  proposals: AgentAReviewProposal[];
  /** 대표가 정할 수정안(대기·보류)이 있는지. */
  needsDecision: boolean;
}

/**
 * 댓글을 첫 댓글별로 묶는다. 순서: 안 끝난 것 먼저, 갈라 낸 질문 먼저, 최근에 바뀐 것 먼저(원래 화면과 같다).
 * 묶음 안은 쓴 차례.
 */
export function buildThreads(annotations: readonly AgentAReviewAnnotation[], proposals: readonly AgentAReviewProposal[] = []): ReviewThread[] {
  const groups = new Map<string, AgentAReviewAnnotation[]>();
  for (const a of annotations) {
    const root = threadRoot(annotations, a.id);
    const list = groups.get(root);
    if (list) list.push(a);
    else groups.set(root, [a]);
  }
  const threads: ReviewThread[] = [];
  for (const [rootId, list] of groups) {
    const root = list.find((a) => a.id === rootId);
    if (!root) continue;
    const messages = [...list].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ids = new Set(list.map((a) => a.id));
    const own = proposals.filter((p) => ids.has(p.annotationId));
    threads.push({
      root,
      messages,
      latest: Math.max(...list.map((a) => a.updatedAt ?? a.createdAt)),
      done: root.resolved || own.some((p) => p.status === "applied"),
      writing: list.some((a) => a.writing),
      failed: list.some((a) => a.ai && a.error !== null),
      proposals: own,
      needsDecision: own.some((p) => p.status === "pending" || p.status === "held"),
    });
  }
  return threads.sort((a, b) => Number(a.done) - Number(b.done) || Number(Boolean(b.root.branchOf)) - Number(Boolean(a.root.branchOf)) || b.latest - a.latest);
}

export interface TurnItem {
  threadId: string;
  answerId: string;
  text: string;
  needsDecision: boolean;
}

/**
 * 내 차례: 댓글마다 마지막 답 하나. 아직 읽지 않았거나(읽은 글과 다르거나) 정할 수정안이 있는 것만.
 * 쓰는 중인 답은 넣지 않는다. read 는 '답 id → 읽은 글'.
 */
export function myTurn(threads: readonly ReviewThread[], read: Readonly<Record<string, string>>): TurnItem[] {
  const out: TurnItem[] = [];
  for (const t of threads) {
    const answer = [...t.messages].reverse().find((m) => m.ai);
    if (!answer || answer.writing) continue;
    const text = answer.text || answer.error?.message || "";
    if (!text) continue;
    const pending = t.proposals.some((p) => p.annotationId === answer.id && (p.status === "pending" || p.status === "held"));
    if (pending || read[answer.id] !== text) out.push({ threadId: t.root.id, answerId: answer.id, text, needsDecision: pending });
  }
  return out;
}

/** 한 줄 미리 보기: 줄바꿈을 빈칸으로, max 자에서 줄인다. */
export function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 글 찾기용: 빈칸 뭉치를 빈칸 하나로. 고른 글은 줄바꿈이 섞이고, 그려진 글은 문단 사이에 빈칸이 없어서 둘을 같은 모양으로 맞춘다. */
export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface OutlineItem {
  level: 1 | 2 | 3;
  text: string;
  /** 같은 수준·종류와 상관없이 문서에서 몇 번째 머리말인지(0부터). 그려진 h1~h3 의 순서와 같다. */
  index: number;
}

/** 본문의 머리말(# ## ###). 코드 울타리 안은 건너뛴다. 목차에 쓴다. */
export function outline(markdown: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const mark = f[1]!;
      if (fence === null) fence = mark[0]!.repeat(mark.length);
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) out.push({ level: h[1]!.length as 1 | 2 | 3, text: h[2]!.replace(/[*_`]/g, ""), index: out.length });
  }
  return out;
}

export type DocPart = { kind: "markdown"; text: string } | { kind: "image"; src: string; alt: string; line: number } | { kind: "mermaid"; code: string };

const IMAGE_LINE = /^!\[((?:[^\]\\]|\\.)*)\]\((\/assets\/(?:user\/[a-f0-9]{64}\/1|workbench-flow\.svg))\)\s*$/;

/**
 * 본문을 글 조각과 그림으로 나눈다. Agent-A 는 그림 블록을 한 줄(![제목](경로))로 싣는다. 그 줄만 그림으로 떼고 나머지는 글이다.
 * line 은 그림 줄의 줄 번호(1부터). 코드 울타리 안은 떼지 않는다.
 */
export function splitDoc(markdown: string): DocPart[] {
  const parts: DocPart[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  /** mermaid 울타리 안이면 그 코드 줄들(울타리 줄은 뺀다). */
  let diagram: string[] | null = null;
  const flush = () => {
    if (buf.join("\n").trim()) parts.push({ kind: "markdown", text: buf.join("\n") });
    buf = [];
  };
  markdown.split("\n").forEach((line, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (f) {
      const mark = f[1]!;
      if (fence === null) {
        fence = mark[0]!.repeat(mark.length);
        // ```mermaid 울타리는 도식으로 따로 그린다(Agent-A 의 mermaid 블록이 이 모양으로 온다).
        if (f[2]!.trim().toLowerCase() === "mermaid") {
          flush();
          diagram = [];
          return;
        }
      } else if (mark[0] === fence[0] && mark.length >= fence.length && !f[2]!.trim()) {
        fence = null;
        if (diagram) {
          parts.push({ kind: "mermaid", code: diagram.join("\n") });
          diagram = null;
          return;
        }
      } else if (diagram) {
        diagram.push(line);
        return;
      }
      buf.push(line);
      return;
    }
    if (diagram) {
      diagram.push(line);
      return;
    }
    const m = fence === null ? IMAGE_LINE.exec(line) : null;
    if (!m) {
      buf.push(line);
      return;
    }
    flush();
    parts.push({ kind: "image", src: m[2]!, alt: m[1]!.replace(/\\(.)/g, "$1"), line: i + 1 });
  });
  // 닫히지 않은 mermaid 울타리는 도식이 아니라 글로 보인다.
  const open = diagram as string[] | null;
  if (open) {
    const last = parts[parts.length - 1];
    const text = ["```mermaid", ...open].join("\n");
    // 울타리 앞의 글과 한 조각으로 둔다(원래 글 그대로).
    if (last?.kind === "markdown") last.text += `\n${text}`;
    else buf.push(text);
  }
  flush();
  return parts;
}

/** 그림 줄에 맞는 그림 정보. 같은 그림이 여러 번 나오면 줄 번호가 가장 가까운 것. */
export function imageFor(images: readonly AgentAReviewImage[], src: string, line: number): AgentAReviewImage | null {
  const same = images.filter((i) => i.src === src);
  if (!same.length) return null;
  return same.reduce((best, i) => (Math.abs(i.sourceLine - line) < Math.abs(best.sourceLine - line) ? i : best));
}

/**
 * 화면에서 끈 사각형(그려진 그림 기준, 0~1 비율)을 그림 자신의 픽셀 사각형(정수)으로 옮긴다.
 * 그림 밖으로 나간 부분은 잘라 내고, 너무 작으면(가로나 세로가 1픽셀 미만) null.
 */
export function regionOf(image: Pick<AgentAReviewImage, "src" | "width" | "height" | "sourceLine">, a: { x: number; y: number }, b: { x: number; y: number }): AgentAReviewImageRegion | null {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = Math.floor(clamp(Math.min(a.x, b.x)) * image.width);
  const y0 = Math.floor(clamp(Math.min(a.y, b.y)) * image.height);
  const x1 = Math.ceil(clamp(Math.max(a.x, b.x)) * image.width);
  const y1 = Math.ceil(clamp(Math.max(a.y, b.y)) * image.height);
  const w = Math.min(image.width, x1) - x0;
  const h = Math.min(image.height, y1) - y0;
  if (w < 1 || h < 1) return null;
  return { v: 1, src: image.src, sourceLine: image.sourceLine, naturalWidth: image.width, naturalHeight: image.height, box: { x: x0, y: y0, w, h } };
}

/** 영역을 그림 위에 그릴 자리(%). */
export function regionStyle(region: AgentAReviewImageRegion): { left: string; top: string; width: string; height: string } {
  const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`;
  return { left: pct(region.box.x, region.naturalWidth), top: pct(region.box.y, region.naturalHeight), width: pct(region.box.w, region.naturalWidth), height: pct(region.box.h, region.naturalHeight) };
}

export interface DiffPart {
  kind: "same" | "add" | "del";
  text: string;
}

const DIFF_CELLS = 4_000_000;

function lcsDiff(a: readonly string[], b: readonly string[]): DiffPart[] {
  // 앞뒤 같은 부분을 먼저 떼어 표를 줄인다
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail), B = b.slice(head, b.length - tail);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  push("same", a.slice(0, head).join(""));
  if (A.length * B.length > DIFF_CELLS) {
    // 너무 크면 가운데를 통째로 바뀐 것으로 본다(멈추지 않게)
    push("del", A.join(""));
    push("add", B.join(""));
  } else {
    const n = A.length, m = B.length, w = m + 1;
    const table = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i * w + j] = A[i] === B[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { push("same", A[i]!); i++; j++; }
      else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) { push("del", A[i]!); i++; }
      else { push("add", B[j]!); j++; }
    }
    while (i < n) push("del", A[i++]!);
    while (j < m) push("add", B[j++]!);
  }
  push("same", a.slice(a.length - tail).join(""));
  return out;
}

/** 낱말 단위 비교(빈칸은 그대로 둔다). 고친 곳을 전후로 보여 줄 때 쓴다. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const tokens = (s: string) => s.split(/(\s+)/).filter((t) => t !== "");
  return lcsDiff(tokens(before), tokens(after));
}

/** 수정안 상태의 화면 글. */
export const PROPOSAL_LABEL: Record<AgentAReviewProposal["status"], string> = {
  pending: "저장 전",
  held: "보류",
  rejected: "거절",
  applied: "저장됨",
  conflict: "충돌 · 다시 확인 필요",
};

/** 댓글 종류의 화면 글. */
export function kindLabel(a: Pick<AgentAReviewAnnotation, "kind" | "region">): string {
  if (a.region) return "그림 영역";
  return a.kind === "global" ? "전체" : a.kind === "deletion" ? "삭제 표시" : "문장";
}
