// 체험판 테스트 실행기. 외부 모델·CLI·네트워크를 부르지 않는다(외부 호출 0건).
// 실행(run)마다 서버가 그 실행의 입력 기록만 문맥으로 넘긴다. 실행기는 받은 문맥 밖의 것을 알 수 없으므로
// 같은 역할의 두 업무가 서로의 입력을 보는지 이 기록으로 검증할 수 있다. 응답은 정해진 대본이다.
import type { DecisionOption, InputSource } from "../../shared/work-types.ts";

export interface TrialJob {
  runId: string;
  taskId: string;
  inputId: string;
  source: InputSource;
  text: string;
  model: string;
  roleName: string;
  template: string;
  taskTitle: string;
  /** 이 실행이 지금까지 받은 입력 전부(이번 입력 포함). 다른 실행의 입력은 들어오지 않는다. */
  context: { source: InputSource; text: string }[];
  /** 협업 질문을 보낸 쪽(답을 돌려줄 곳). */
  peer?: { taskId: string; title: string } | null;
}

export interface TrialOutput {
  runId: string;
  taskId: string;
  inputId: string;
  replies: string[];
  file?: { title: string; content: string };
  decision?: { title: string; detail: string; options: DecisionOption[] };
  collabAsk?: { template: string; question: string };
  collabAnswer?: { toTaskId: string; answer: string };
  readyToComplete?: boolean;
}

export interface TrialRunnerOptions { delayMs?: number; onOutput: (out: TrialOutput) => void }

const PHRASE = /식별[:：]\s*([^\s,.)]+)/g;

export class TrialRunner {
  readonly kind = "trial" as const;
  /** 실행기가 실제로 받은 입력(실행별). 시험에서 문맥 섞임을 본다. */
  readonly received = new Map<string, string[]>();
  readonly externalCalls = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;
  constructor(private readonly opts: TrialRunnerOptions) {}

  send(job: TrialJob): void {
    if (this.closed) return;
    const seen = this.received.get(job.runId) ?? [];
    seen.push(job.text);
    this.received.set(job.runId, seen);
    const base = this.opts.delayMs ?? 1500;
    const delay = /천천히/.test(job.text) ? base * 4 : base;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) this.opts.onOutput(respond(job));
    }, delay);
    this.timers.add(timer);
  }

  get pending(): number { return this.timers.size; }
  close(): void { this.closed = true; for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
}

export function phrasesOf(context: { text: string }[]): string[] {
  const out = new Set<string>();
  for (const c of context) for (const m of c.text.matchAll(PHRASE)) out.add(m[1]!);
  return [...out];
}

/** 대본. 같은 입력·문맥이면 같은 응답을 낸다. */
export function respond(job: TrialJob): TrialOutput {
  const tag = `[테스트 실행 · ${job.roleName} · ${job.model} · ${job.runId.slice(-6)}]`;
  const phrases = phrasesOf(job.context);
  const memo = phrases.length ? ` 이 실행 문맥의 식별 문구: ${phrases.join(", ")}.` : "";
  const out: TrialOutput = { runId: job.runId, taskId: job.taskId, inputId: job.inputId, replies: [] };
  const say = (s: string) => out.replies.push(`${tag} ${s}${memo}`);
  const ownerCount = job.context.filter((c) => c.source === "owner").length;
  const first = job.source === "owner" && ownerCount === 1;
  const short = job.text.replace(/\s+/g, " ").slice(0, 60);

  switch (job.source) {
    case "handoff":
      say(`인계를 받았습니다. 이 업무(${job.taskTitle})의 기록만 넘겨받았고, 이전 실행의 대화는 이어받지 않았습니다.`);
      return out;
    case "collab_question":
      out.collabAnswer = { toTaskId: job.peer?.taskId ?? "", answer: job.template === "integration"
        ? "연동 범위: 업무 원장·테스트 실행·Hindsight 접점까지입니다. 실제 외부 연결은 이번 범위가 아닙니다."
        : `${job.taskTitle} 담당의 답: 지금까지 받은 지시 ${job.context.filter((c) => c.source === "owner").length}건 기준으로 진행 중입니다.` };
      say(`다른 업무(${job.peer?.title ?? "?"})의 질문에 답했습니다: "${short}"`);
      return out;
    case "collab_answer":
      out.file = { title: "소개 글 초안", content: `# 소개 글 초안\n\n- 선행 업무(대화 구조 검토) 결과를 반영했습니다.\n- 협업 답(연동 구현): ${job.text}\n\n업무마다 대화가 따로 이어지고, 답할 일은 '내 차례'에 모입니다.` };
      out.readyToComplete = true;
      say("협업 답을 반영해 소개 글 초안을 만들었습니다. 확인 후 완료 처리하시면 됩니다.");
      return out;
    case "dependency":
      out.collabAsk = { template: "integration", question: "소개 글에 넣을 연동 범위를 한 줄로 알려 주세요" };
      say("선행 업무 결과를 받았습니다. 연동 구현 담당 실행에 확인 질문을 보냈습니다.");
      return out;
    case "answer":
      if (job.template === "quote") {
        out.file = { title: `견적 비교표 — ${job.text}`, content: `# 견적 비교표\n\n조건: **${job.text}**\n\n| 업체 | 가격 | 납기 |\n|---|---|---|\n| 가 | 120만 | 2주 |\n| 나 | 98만 | 4주 |\n| 다 | 110만 | 3주 |` };
        out.readyToComplete = true;
        say(`결정(${job.text})에 맞춰 비교표를 만들었습니다.`);
      } else say(`결정을 받았습니다: ${job.text}`);
      return out;
    default:
      break;
  }

  // 대표 지시
  switch (job.template) {
    case "integration":
      if (/검토/.test(job.text)) out.decision = { title: "연동 방식 검토 요청", detail: "연동 구현 1차가 끝났습니다. 이대로 진행할지 정해 주세요.", options: [{ k: "approve", label: "이대로 진행" }, { k: "revise", label: "보완 후 다시" }] };
      if (first) out.file = { title: "연동 구현 진행 메모", content: "# 연동 구현 진행 메모\n\n- 접점 정리\n- 시험 연결 확인 예정" };
      say(first ? "연동 구현을 시작했습니다. 진행 메모를 올렸습니다." : `후속 지시를 받았습니다: "${short}"`);
      break;
    case "structure":
      if (first) out.file = { title: "대화 구조 1차 검토", content: "# 대화 구조 1차 검토\n\n1안: 프로젝트 단일 대화\n2안: 업무별 대화 + 전체 내 차례" };
      if (/보강/.test(job.text)) {
        out.file = { title: "대화 구조 검토 — 둘째 안 보강", content: "# 둘째 안 보강\n\n- 업무별 대화 + 프로젝트 종합 요약\n- 늦게 온 결과는 원래 업무에만 붙임" };
        out.decision = { title: "둘째 안 보강본으로 확정할까요?", detail: "대화 구조 검토의 둘째 안을 보강했습니다.", options: [{ k: "confirm", label: "확정" }, { k: "more", label: "더 보강" }] };
      }
      say(first ? "대화 구조 검토를 시작했습니다. 1차 검토 자료를 올렸습니다." : `후속 지시를 받았습니다: "${short}"`);
      break;
    case "trip":
      if (first) out.file = { title: "출장 동선 후보 3안", content: "# 출장 동선 후보\n\n1. 오전 KTX\n2. 전날 이동\n3. 항공" };
      say(first ? "출장 동선 조사를 시작했습니다. 후보 3안을 올렸습니다." : `후속 지시를 받았습니다: "${short}"`);
      break;
    case "quote":
      if (first) out.decision = { title: "견적 조건을 골라 주세요", detail: "견적 비교 기준을 정하면 비교표를 만듭니다.", options: [{ k: "price", label: "가격 우선" }, { k: "lead", label: "납기 우선" }, { k: "balance", label: "균형" }] };
      say(first ? "견적 3건을 모았습니다. 비교 조건을 결재함에 올렸습니다." : `후속 지시를 받았습니다: "${short}"`);
      break;
    case "intro":
      say(first ? "소개 글 작성을 맡았습니다." : `후속 지시를 받았습니다: "${short}"`);
      break;
    default:
      if (ownerCount >= 2) out.file = { title: `${job.taskTitle} 중간 결과`, content: `# ${job.taskTitle}\n\n받은 지시 ${ownerCount}건을 반영한 시험 결과입니다.` };
      say(first ? `새 업무를 접수했습니다: "${short}"` : `후속 지시를 받았습니다: "${short}"`);
  }
  return out;
}
