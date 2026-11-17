import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";
import { taskTitleFrom } from "../server/task-names.ts";
import { listAgentTools } from "../server/agent-tools.ts";
import { oneLineProblem } from "../server/text.ts";
import { lintAsk, lintFile, lintPost, lintTask } from "../server/writing-lint.ts";

test("대표가 붙인 업무 이름은 API가 허용한 길이에서 목표와 조건을 끝까지 보존한다", () => {
  const f = fixture();
  const title = "IAMCEO의 결재함과 업무 보고와 자료 목록에서 제목과 상세를 읽는 목적에 맞게 구분하고 운영 서버를 재시작하지 않은 상태에서 표시 동작을 검증한다";
  const id = f.store.ownerTask(f.project.id, { sourceRef: "purpose-owner", newTaskTitle: title, text: "이 이름으로 조사해 주세요", fallbackLabel: "대표 글" });
  expect(f.store.getTask(id!)?.title).toBe(title);
});

test("자동 임시 이름은 한 줄에 맞추려고 목적 문장 뒤의 조사 대상을 잘라 저장하지 않는다", () => {
  const sentence = "IAMCEO의 결재함과 업무 보고와 아티팩트와 팀 진행 상황에서 제목과 상세가 읽는 목적에 맞게 표시되도록 수정";
  expect(taskTitleFrom(sentence + "해줘", "대표 글")).toBe(sentence);
  expect([...taskTitleFrom("업무 대상 ".repeat(40) + "검토해줘", "대표 글")].length).toBeLessThanOrEqual(120);
});

test.each([
  ["task", "업무 이름", { title: "검토" }],
  ["post", "보고 제목", { kind: "진행", title: "진행 상황", body: "로그인 오류의 입력 수신 기록을 확인했습니다. 세션 종료 기록은 아직 찾지 못했습니다." }],
  ["ask", "결재 제목", { title: "확인 요청", detail: "로그인 오류의 진단에 세션 종료 기록이 필요합니다. 익명화한 기록을 제공할지 정해 주세요." }],
  ["file", "자료 제목", { title: "결과물", summary: "로그인 오류의 조사 범위와 미확인 항목을 정리했습니다.", content: "# 로그인 오류 진단서\n\n입력 수신을 확인했습니다. 종료 기록은 미확인입니다." }],
] as const)("%s의 일반 제목에는 목적별 경고를 주되 원문 저장은 막지 않는다", async (name, label, args) => {
  const f = fixture();
  const task = f.store.saveTask({ projectId: f.project.id, memberId: f.worker.id, who: f.worker.name, title: "로그인 재개 오류 진단" }).task;
  const result = await f.tool(f.worker, name, { ...args, ...(name === "task" ? {} : { task_id: task.id }) });
  expect(result.isError).not.toBe(true);
  const stored = name === "task" ? f.store.listTasks(f.project.id).find(t => t.title === args.title)?.title
    : name === "post" ? f.store.listMessages(f.project.id).find(m => m.title === args.title)?.title
    : name === "ask" ? f.store.listDecisions(f.project.id).find(d => d.title === args.title)?.title
    : f.store.listFiles(f.project.id).find(d => d.title === args.title)?.title;
  expect(stored).toBe(args.title);
  expect(result.text).toContain(label);
});

test("직원에게 전달되는 도구 필드는 제목·요약·본문과 상태의 서로 다른 목적을 설명한다", () => {
  const f = fixture();
  const tools = new Map([...listAgentTools(f.worker), ...listAgentTools(f.lead)].map(t => [t.name, t]));
  const description = (name: string, field: string) => ((tools.get(name)!.inputSchema as any).properties[field].description as string);
  expect(description("task", "title")).toContain("대상과 목표");
  expect(description("ask", "title")).toContain("결정할 질문");
  expect(description("post", "title")).toContain("이번에 달라진 결과");
  expect(description("file", "title")).toContain("결과물 종류");
  expect(description("file", "summary")).toContain("열어 볼지");
  expect(description("project_now", "text")).toContain("병목");
});

test("비 BMP 문자를 포함한 임시 이름도 실제 task 입력 한도와 서로게이트 경계를 지킨다", () => {
  for (const source of ["가".repeat(119) + "🚀해줘", "가".repeat(118) + "🚀가해줘", "🚀원인".repeat(40) + "조사해줘"]) {
    const generated = taskTitleFrom(source, "대표 글");
    expect(oneLineProblem(generated, 120)).toBeNull();
    expect(generated.isWellFormed()).toBe(true);
  }
});

test("실제 전달하는 임시 업무 지시는 목적을 40자에 맞춰 다시 자르라고 하지 않는다", async () => {
  const f = fixture();
  const message = await f.orch.sendUserMessage(f.project.id, { text: "로그인 재개 실패 원인을 조사해줘" });
  const delivery = f.store.listDeliveries(f.project.id).find(d => d.refId === message.id);
  expect(delivery).toBeDefined();
  expect(delivery!.text).toContain("임시 이름");
  expect(delivery!.text).not.toContain("40자");
  expect(delivery!.text).toContain("대상과 목표");
});

test("상태만 있는 업무 이름을 안내한다", () => {
  expect(lintTask("검토 중").some(w => w.code === "title-purpose")).toBe(true);
});

test("URL이나 구체적 대상이 있는 제목을 보존한다", () => {
  for (const title of ["https://example.org 확인", "로그인 오류 검토", "검토 의견서"]) {
    for (const warnings of [lintTask(title), lintPost({ title }), lintAsk({ title }), lintFile({ title })]) {
      expect(warnings.filter(w => w.code === "title-purpose")).toEqual([]);
    }
  }
});

test.each([false, true])("진행판에서 작성한 이름에도 같은 경고를 준다(기존 업무 연결: %s)", async linked => {
  const f = fixture();
  const task = f.store.saveTask({ projectId: f.project.id, memberId: f.lead.id, who: f.lead.name, title: "로그인 오류 조사" }).task;
  const result = await f.tool(f.lead, "work_set", { sec: "doing", title: "검토 중", ...(linked ? { task_id: task.id } : {}) });
  expect(result.isError).not.toBe(true);
  expect(result.text).toContain("업무 이름");
  expect(f.store.listWork(f.project.id).some(item => item.title === "검토 중")).toBe(true);
});

test("제목을 제출하지 않은 업무 갱신에서 대표가 정한 이름을 고치라고 경고하지 않는다", async () => {
  const f = fixture();
  const id = f.store.ownerTask(f.project.id, { sourceRef: "owner-title", newTaskTitle: "검토", text: "자료를 검토해 주세요", fallbackLabel: "대표 글" });
  const result = await f.tool(f.lead, "task", { task_id: id });
  expect(result.isError).not.toBe(true);
  expect(result.text).not.toContain("업무 이름:");
  expect(f.store.getTask(id!)?.title).toBe("검토");
});
