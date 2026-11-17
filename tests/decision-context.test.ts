import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";
import { decisionDetail, noticePreview } from "../web/src/lib/decision-view.ts";
import { lintAsk } from "../server/writing-lint.ts";

test("결재 첨부와 인용한 보고의 자료를 먼저 찾고 같은 업무 자료를 따로 표시한다", () => {
  const { store, project, worker } = fixture();
  const task = store.saveTask({ projectId: project.id, memberId: worker.id, title: "헤더 확인", who: worker.name }).task;
  const other = store.saveTask({ projectId: project.id, memberId: worker.id, title: "씬 확인", who: worker.name }).task;
  const unrelated = store.saveTask({ projectId: project.id, memberId: worker.id, title: "결제 확인", who: worker.name }).task;
  const foreign = store.createProject({ name: "다른 프로젝트", cwd: project.cwd });
  const file = (title: string, taskId: string | null, projectId = project.id) =>
    store.createFile({ projectId, title, who: worker.name, taskId, body: "목록에 보낼 필요 없는 전문" });
  const attached = file("화면 적용 비교표", task.id);
  const cited = file("씬의 독립 검수 결과", other.id);
  const supporting = file("씬의 수정 전후 화면", other.id);
  const same = file("헤더 재현 기록", task.id);
  const wrong = file("다른 결제 작업", unrelated.id);
  const wrongProject = file("다른 프로젝트의 근거", null, foreign.id);
  const report = store.createMessage({ id: "msg_review", projectId: project.id, who: worker.name, kind: "완료", title: "씬 검수 완료", body: "", taskId: other.id });
  store.saveReportReferences(project.id, { sourceMessageId: report.id, fileIds: [cited.id, attached.id], decisionIds: [], authoredAt: report.at, sequence: 1, correctsMessageId: null });
  for (let i = 0; i < 21; i++) file(`별도 파일 ${i}`, unrelated.id);
  expect(store.listFilePage(project.id).items.map(f => f.id)).not.toContain(same.id);

  const decision = store.createDecision({ projectId: project.id, who: worker.name, taskId: task.id, title: "화면을 적용할까요?",
    fileId: attached.id, detail: `검수 보고 ${report.id}을 읽어 주세요. 다른 프로젝트를 가리키는 ${wrongProject.id}도 있습니다.` });
  const context = store.getDecisionContext(decision.id);
  expect(context.references).toEqual([{ id: attached.id, title: attached.title }, { id: cited.id, title: cited.title }]);
  expect(context.tasks).toEqual([
    { id: task.id, title: task.title, files: [{ id: same.id, title: same.title }] },
    { id: other.id, title: other.title, files: [{ id: supporting.id, title: supporting.title }] },
  ]);
  expect(JSON.stringify(context)).not.toContain(wrong.id);
  expect(JSON.stringify(context)).not.toContain(wrongProject.id);
});

test("결재가 참조한 업무가 없으면 프로젝트 전체 자료를 연결하지 않는다", () => {
  const { store, project, worker } = fixture();
  store.createFile({ projectId: project.id, title: "무관한 파일", who: worker.name });
  const decision = store.createDecision({ projectId: project.id, who: worker.name, title: "진행할까요?" });
  expect(store.getDecisionContext(decision.id)).toEqual({ references: [], tasks: [] });
});

test("업무 연결이 없는 옛 결재에도 결재 ID로 연결한 보고의 자료를 찾는다", () => {
  const { store, project, worker } = fixture();
  const decision = store.createDecision({ projectId: project.id, who: worker.name, title: "수정판을 적용할까요?" });
  const evidence = store.createFile({ projectId: project.id, who: worker.name, title: "적용 근거" });
  const report = store.createMessage({ projectId: project.id, who: worker.name, kind: "진행", title: "검토 결과", body: "", decisionId: decision.id });
  store.saveReportReferences(project.id, { sourceMessageId: report.id, fileIds: [evidence.id], decisionIds: [decision.id], authoredAt: report.at, sequence: 1, correctsMessageId: null });
  expect(store.getDecisionContext(decision.id).references).toEqual([{ id: evidence.id, title: evidence.title }]);
});

test("이전 문구의 뜻과 원문 연결 상태를 밝히고, 작성자에게 출처를 적도록 안내한다", () => {
  const boilerplate = "대표 요청에 따른 외부 검수 대행입니다.";
  const original = boilerplate + "\n\n검수한 판을 대표 화면에 적용할지 정합니다.";
  expect(decisionDetail(original)).toBe("별도로 진행한 검수 결과를 바탕으로 올린 결재입니다.\n\n검수한 판을 대표 화면에 적용할지 정합니다.");
  expect(decisionDetail(`> ${boilerplate}`)).toBe(`> ${boilerplate}`);
  const quoted = ["```text", boilerplate, "```"].join("\n");
  expect(decisionDetail(quoted)).toBe(quoted);
  expect(lintAsk({ title: "어느 판을 적용할까요?", detail: original }).some(w => w.code === "review-context")).toBe(true);
});

test("완료 요약이 5개를 넘지 않고 미검증을 먼저 보여 주며 원문을 보존한다", () => {
  const lines = ["요청한 결과: 헤더 개선", "확정 완료 기준 r2: 긴 기준", "완료 보고: 철수 '헤더 검증' · 2026-11-18 · 보고 메시지 ID msg_abc",
    "메인 합침: 1a2b3c4 · 2026-11-18", "대표 화면 반영: Tailscale에서 확인 · 2026-11-18",
    "완료 판단: 총괄 · 근거 · 2026-11-18", "미검증: iOS 세로 모드"];
  const preview = noticePreview(lines);
  expect(preview).toHaveLength(5);
  expect(preview[0]).toBe("미검증: iOS 세로 모드");
  expect(preview).toContain("완료 보고: 철수 '헤더 검증'");
  expect(preview).toContain("대표 화면 반영: Tailscale에서 확인");
  expect(lines[2]).toContain("보고 메시지 ID msg_abc");
});
