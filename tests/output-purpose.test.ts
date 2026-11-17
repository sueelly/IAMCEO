import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";
import { taskTitleFrom } from "../server/task-names.ts";
import { listAgentTools } from "../server/agent-tools.ts";

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
  const tools = new Map(listAgentTools(f.lead).map(t => [t.name, t]));
  const description = (name: string, field: string) => ((tools.get(name)!.inputSchema as any).properties[field].description as string);
  expect(description("task", "title")).toContain("대상과 목표");
  expect(description("ask", "title")).toContain("결정할 질문");
  expect(description("post", "title")).toContain("이번에 달라진 결과");
  expect(description("file", "title")).toContain("결과물 종류");
  expect(description("file", "summary")).toContain("열어 볼지");
  expect(description("project_now", "text")).toContain("병목");
});
