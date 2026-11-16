// 빠른 라벨: 고른 글에 한 번 눌러 붙이는, 미리 정해 둔 한 줄 의견. 원래 Agent-A 화면의 기본 라벨을 우리말로 옮겼다.
// 라벨은 댓글로 남는다(글은 '이모지 이름' 한 줄). 지침(tip)은 그 라벨에 딸린 말로, 검토 제출 때 함께 넘어간다.
// 고친 라벨은 이 기기 브라우저에만 기억한다(원래 화면도 브라우저에 둔다).

export type LabelTone = "blue" | "red" | "orange" | "yellow" | "purple" | "teal" | "pink" | "green" | "cyan" | "amber";
export const LABEL_TONES: { key: LabelTone; label: string }[] = [
  { key: "yellow", label: "노랑" },
  { key: "orange", label: "주황" },
  { key: "amber", label: "호박" },
  { key: "red", label: "빨강" },
  { key: "pink", label: "분홍" },
  { key: "purple", label: "보라" },
  { key: "blue", label: "파랑" },
  { key: "cyan", label: "하늘" },
  { key: "teal", label: "청록" },
  { key: "green", label: "초록" },
];

export interface QuickLabel {
  id: string;
  emoji: string;
  text: string;
  tone: LabelTone;
  tip?: string;
}

/** 늘 맨 위에 있는 한 번 누르는 칭찬. 고치는 목록에는 들지 않는다. */
export const THUMBS_UP: QuickLabel = { id: "thumbs-up", emoji: "👍", text: "좋아요", tone: "green" };

export const DEFAULT_LABELS: QuickLabel[] = [
  { id: "clarify-this", emoji: "❓", text: "더 설명해 주세요", tone: "yellow" },
  { id: "missing-overview", emoji: "🗺️", text: "큰 그림이 없어요", tone: "purple", tip: "무엇을, 왜, 어떻게 하려는지 먼저 이야기로 설명해 주세요. 세부 내용보다 앞에 두세요." },
  { id: "verify-this", emoji: "🔍", text: "확인이 필요해요", tone: "orange", tip: "추측으로 보입니다. 실제 자료를 읽고 확인한 뒤에 진행해 주세요." },
  { id: "give-me-an-example", emoji: "🔬", text: "예를 들어 주세요", tone: "cyan", tip: "너무 추상적입니다. 전후 비교나 입력과 결과의 예, 구체적인 상황으로 보여 주세요." },
  { id: "match-existing-patterns", emoji: "🧬", text: "기존 방식에 맞춰 주세요", tone: "teal", tip: "이미 있는 방식과 부품을 먼저 찾아 다시 쓰고, 새 방식을 들이지 마세요." },
  { id: "consider-alternatives", emoji: "🔄", text: "다른 방법도 봐 주세요", tone: "pink", tip: "실제 자료를 바탕으로 다른 방법 두세 가지와 그 장단점을 제안해 주세요." },
  { id: "ensure-no-regression", emoji: "📉", text: "기존 동작을 지켜 주세요", tone: "amber", tip: "이 변경이 기존 동작을 깨지 않는지 확인하고, 무엇이 깨질 수 있고 어떻게 막을지 밝혀 주세요." },
  { id: "out-of-scope", emoji: "🚫", text: "범위 밖이에요", tone: "red", tip: "이번 일에 들지 않습니다. 빼고, 요청한 것에 집중해 주세요." },
  { id: "needs-tests", emoji: "🧪", text: "시험이 필요해요", tone: "blue" },
  { id: "nice-approach", emoji: "👍", text: "좋은 방법이에요", tone: "green" },
];

export const MAX_LABELS = 12;
const KEY = "iamceo.agentA.labels";
const TONES = new Set<string>(LABEL_TONES.map((t) => t.key));

/** 저장된 라벨 한 줄을 다듬는다. 모양이 틀리면 null. */
export function cleanLabel(v: unknown): QuickLabel | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  const text = typeof x.text === "string" ? x.text.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  const emoji = typeof x.emoji === "string" ? x.emoji.replace(/\s+/g, "").slice(0, 8) : "";
  if (!text || typeof x.id !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(x.id)) return null;
  const tip = typeof x.tip === "string" ? x.tip.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return { id: x.id, emoji, text, tone: TONES.has(String(x.tone)) ? (x.tone as LabelTone) : "yellow", ...(tip ? { tip } : {}) };
}

/** 이 기기에 기억한 라벨. 없거나 읽지 못하면 기본 라벨. */
export function loadLabels(storage: () => Storage = () => localStorage): QuickLabel[] {
  try {
    const raw = JSON.parse(storage().getItem(KEY) ?? "null") as unknown;
    if (!Array.isArray(raw)) return DEFAULT_LABELS;
    const seen = new Set<string>();
    const list = raw.flatMap((v) => {
      const label = cleanLabel(v);
      if (!label || seen.has(label.id)) return [];
      seen.add(label.id);
      return [label];
    }).slice(0, MAX_LABELS);
    return list.length ? list : DEFAULT_LABELS;
  } catch {
    return DEFAULT_LABELS;
  }
}

/** 고친 라벨을 기억한다. null 이면 기본 라벨로 되돌린다. */
export function saveLabels(labels: QuickLabel[] | null, storage: () => Storage = () => localStorage): void {
  try {
    if (labels === null) storage().removeItem(KEY);
    else storage().setItem(KEY, JSON.stringify(labels.slice(0, MAX_LABELS)));
  } catch {
    // 저장소를 못 쓰는 브라우저 설정이면 이 창에서만 쓴다
  }
}

/** 댓글에 남는 라벨 글: '이모지 이름'. */
export const labelText = (label: Pick<QuickLabel, "emoji" | "text">): string => `${label.emoji ? `${label.emoji} ` : ""}${label.text}`;

/** 댓글 글이 어느 라벨인지(색을 맞추는 데 쓴다). 모르면 null. */
export function labelOf(text: string, labels: readonly QuickLabel[]): QuickLabel | null {
  return [THUMBS_UP, ...labels].find((l) => labelText(l) === text.trim()) ?? null;
}
