// 모든 글의 업무: 대표 글·자료·보고 보완·서버 알림이 업무 없이 남지 않고, 새 업무 이름은 비밀값·내부 번호 없이 글의 목적 문장으로 만든다(임시 이름).
// 재시도해도 업무가 늘지 않고, 옛 글 정리는 원문을 바꾸지 않으며 묶음 단위로 되돌린다.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend, Delivery } from "../shared/types.ts";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { MIGRATIONS, openDb } from "../server/db.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import type { Runner } from "../server/runner/types.ts";
import { Store } from "../server/store.ts";
import { applyTaskBackfill, planTaskBackfill, undoTaskBackfill } from "../server/task-backfill.ts";
import { datedTitle, scrubTaskText, taskTitleFrom } from "../server/task-names.ts";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "iamceo-everywhere-"));
  const env = { IAMCEO_HOME: home, IAMCEO_PORT: "0" };
  updateConfigFile({ accessCode: "code", hosts: ["127.0.0.1"] }, env);
  const config = loadConfig(env);
  const store = new Store(openDb(config.dbPath), new Bus());
  const orch = new Orchestrator({ config, store, runners: new Map<Backend, Runner>() });
  const project = store.createProject({ name: "시험", cwd: home });
  const lead = store.createMember({ projectId: project.id, kind: "conductor", name: "총괄", handle: "lead", role: "총괄" } as never);
  const w = store.createMember({ projectId: project.id, kind: "worker", name: "철수", handle: "w1", role: "개발" } as never);
  return { home, config, store, orch, project, lead, w };
}

describe("새 업무 이름", () => {
  test("부탁이 든 첫 문장을 목적으로 보고, 주소·내부 번호·해시·경로·비밀값을 지우고 40자로 자른다", () => {
    const fb = datedTitle("대표 글", "2026-11-13T11:15:00Z");
    expect(fb).toBe("대표 글 11월 13일 20:15");
    expect(taskTitleFrom("아니 접속코드는 언제나 1118로 통일해", fb)).toBe("접속코드는 언제나 …로 통일");
    expect(taskTitleFrom("https://example.com/a/b 이거 봐줘", fb)).toBe("이거 봐줘");
    expect(taskTitleFrom("msg_aQb2xaTxxgfA 보고 다시 봐줘 6b98ccc 커밋 기준", fb)).toBe("보고 다시 봐줘 … 커밋 기준");
    expect(taskTitleFrom("/Users/me/Projects/x 폴더 정리, 127.0.0.1:7881 다시 열기", fb)).not.toMatch(/Users|7881|127\.0/);
    expect(taskTitleFrom("키 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAA 넣어둠", fb)).toBe("키 … 넣어둠");
    expect(taskTitleFrom("메일 me@example.com 로 보내", fb)).toBe("메일 … 로 보내");
    // 인용은 남의 말이라 대표가 쓴 줄을 먼저 쓴다. 마크다운 꾸밈은 걷는다. 한글 나열(/)은 남긴다
    expect(taskTitleFrom("> 인용한 줄\n\n## 디자인/개발/시험 **일정** 정리", fb)).toBe("디자인/개발/시험 일정 정리");
    expect(taskTitleFrom("코드 검사 돌려줘", fb)).toBe("코드 검사 돌려줘");
    // 남는 글자가 없으면 시각 이름
    expect(taskTitleFrom("https://example.com", fb)).toBe(fb);
    expect(taskTitleFrom("", fb)).toBe(fb);
    // 첫 줄이 아니라 목적 문장(대표 2026-11-14 결재 답): 상황 설명·불만 문장을 건너 부탁 문장을 쓰고, 끝의 부탁 말을 뗀다
    expect(taskTitleFrom("지금 전체 제외하고 작업 클릭했을 때 대화가 모두 없다고 떠. 작업 부여하고 관리하는 부분 한번 확인해봐", fb)).toBe("작업 부여하고 관리하는 부분 한번 확인");
    expect(taskTitleFrom("지금 업무 선택할 때, 직원까지 함께 선택될 필요는 없는 것 같아. 모든 것에 업무가 붙도록 해줘. 그리고 알림이 너무 많거든?", fb)).toBe("모든 것에 업무가 붙도록");
    expect(taskTitleFrom("합치고 대표 화면에 반영해", fb)).toBe("합치고 대표 화면에 반영");
    // 부탁 문장이 없으면 첫 문장. 부탁 말을 떼고 남는 게 없으면 그 문장 그대로
    expect(taskTitleFrom("어떻게 돼가?", fb)).toBe("어떻게 돼가?");
    const long = taskTitleFrom("배포 전에 결제 화면과 정산 화면과 알림 화면과 설정 화면의 글자 크기를 모두 같은 기준으로 맞춰 줘", fb);
    expect([...long].length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
    expect(scrubTaskText("비밀번호: hunter22 바꿔")).toBe("비밀번호: … 바꿔");
  });
});

describe("업무 이름을 목적으로 바꾸기", () => {
  test("서버가 지은 이름은 임시라 전달 글에 바꾸라는 안내가 붙고, 총괄이 목적 이름으로 바꾸면 안내가 빠진다", async () => {
    const t = setup();
    const m = await t.orch.sendUserMessage(t.project.id, { text: "지금 알림이 너무 많아. 중복을 분석하고 개선안을 내놔" });
    const task = t.store.requireTask(m.taskId!);
    expect(task).toMatchObject({ origin: "auto", title: "중복을 분석하고 개선안을", renamedAt: null });
    const first = t.store.listDeliveries(t.project.id).find((d) => d.memberId === t.lead.id && d.refId === m.id)!;
    expect(first.text).toContain("서버가 글에서 지은 임시 이름");
    expect(first.text).toContain(`task_id "${task.id}"`);
    const tool = await t.orch.handleAgentTool(t.lead, "task", { task_id: task.id, title: "알림 중복 분석·개선안" });
    expect(tool.isError).toBeUndefined();
    const renamed = t.store.requireTask(task.id);
    expect(renamed).toMatchObject({ title: "알림 중복 분석·개선안", renamedBy: "총괄" });
    expect(renamed.renamedAt).toEqual(expect.any(String));
    // 대화 중 목적이 바뀌면 다시 바꾼다. 바꾼 뒤 전달 글에는 임시 안내가 없다
    expect((await t.orch.handleAgentTool(t.lead, "task", { task_id: task.id, title: "알림 줄이기 구현" })).isError).toBeUndefined();
    const next = await t.orch.sendUserMessage(t.project.id, { text: "구현도 해", taskId: task.id });
    const later = t.store.listDeliveries(t.project.id).find((d) => d.memberId === t.lead.id && d.refId === next.id)!;
    expect(later.text).toContain("'알림 줄이기 구현'");
    expect(later.text).not.toContain("임시 이름");
  });

  test("대표가 이름 붙인 업무는 직원이 바꾸지 않는다. 직원·진행판 업무에는 임시 안내가 없다", async () => {
    const t = setup();
    const named = await t.orch.sendUserMessage(t.project.id, { text: "이번 주 안에", newTaskTitle: "견적서 개편" });
    const owner = t.store.requireTask(named.taskId!);
    const refused = await t.orch.handleAgentTool(t.lead, "task", { task_id: owner.id, title: "다른 이름" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("대표가 이름 붙인 업무");
    expect(t.store.requireTask(owner.id).title).toBe("견적서 개편");
    const delivered = t.store.listDeliveries(t.project.id).find((d) => d.memberId === t.lead.id && d.refId === named.id)!;
    expect(delivered.text).not.toContain("임시 이름");
    const staff = await t.orch.handleAgentTool(t.w, "task", { title: "결제 연동" });
    expect(staff.text).not.toContain("임시 이름");
  });
});

describe("대표 글·자료의 업무", () => {
  test("업무 없이 보낸 글은 첫 줄 이름의 새 업무(auto), 이름을 주면 그 이름(owner). 같은 id 로 다시 보내도 업무는 하나다", async () => {
    const t = setup();
    const m1 = await t.orch.sendUserMessage(t.project.id, { id: "m-1", text: "견적서 양식 만들어 줘\n세부는 이렇고" });
    const auto = t.store.requireTask(m1.taskId!);
    expect(auto).toMatchObject({ title: "견적서 양식 만들어 줘", origin: "auto", memberId: null, parentTaskId: null });
    const again = await t.orch.sendUserMessage(t.project.id, { id: "m-1", text: "견적서 양식 만들어 줘\n세부는 이렇고" });
    expect(again.taskId).toBe(auto.id);
    expect(t.store.listTasks(t.project.id)).toHaveLength(1);
    // 같은 글을 새 id 로 보내면(대표가 두 번 보냄) 새 업무다(같은 글이라도 다른 글)
    const named = await t.orch.sendUserMessage(t.project.id, { text: "이번 주 안에", newTaskTitle: "  견적서 개편  " });
    expect(t.store.requireTask(named.taskId!)).toMatchObject({ title: "견적서 개편", origin: "owner" });
    await expect(t.orch.sendUserMessage(t.project.id, { text: "둘 다", taskId: auto.id, newTaskTitle: "새 이름" })).rejects.toThrow(/함께 보내지 않습니다/);
    // 총괄에게 가는 전달에도 그 업무 줄이 붙는다
    const delivered = t.store.listDeliveries(t.project.id).filter((d) => d.memberId === t.lead.id && d.refId === m1.id);
    expect(delivered).toHaveLength(1);
    expect(t.store.deliveryTaskId(delivered[0]!.id)).toBe(auto.id);
    expect(delivered[0]!.text).toContain(`작업 #${auto.id} '견적서 양식 만들어 줘'`);
    await t.orch.shutdown();
  });

  test("직원에게 직접 보낸 글의 총괄 알림도 그 글의 업무에 붙는다. 본사 대화는 업무를 쓰지 않는다", async () => {
    const t = setup();
    const m = await t.orch.sendUserMessage(t.project.id, { text: "철수야 로그 봐 줘", targetMemberId: t.w.id });
    const notice = t.store.listDeliveries(t.project.id).find((d) => d.memberId === t.lead.id && d.kind === "system")!;
    expect(t.store.deliveryTaskId(notice.id)).toBe(m.taskId!);
    expect(notice.text).toContain(`작업 #${m.taskId}`);
    const hq = await t.orch.sendUserMessage("hq", { text: "본사에 묻는 말" });
    expect(hq.taskId ?? null).toBeNull();
    expect(t.store.listTasks("hq")).toHaveLength(0);
    await expect(t.orch.sendUserMessage("hq", { text: "x", newTaskTitle: "본사 업무" })).rejects.toThrow(/본사/);
    await t.orch.shutdown();
  });

  test("대표가 자료 화면에 올린 자료도 업무에 붙고, 같은 파일을 다시 올려도 업무가 늘지 않는다", () => {
    const t = setup();
    const id = t.store.ownerTask(t.project.id, { sourceRef: "file-path:/x/보고서.md", text: "자료 보고서.md", fallbackLabel: "대표 자료" })!;
    expect(t.store.requireTask(id)).toMatchObject({ title: "자료 보고서.md", origin: "auto" });
    expect(t.store.ownerTask(t.project.id, { sourceRef: "file-path:/x/보고서.md", text: "자료 보고서.md", fallbackLabel: "대표 자료" })).toBe(id);
    expect(t.store.listTasks(t.project.id)).toHaveLength(1);
  });
});

describe("서버가 남기는 글의 업무", () => {
  test("보고 보완 전달은 그 실행이 받은 업무 줄을 달고, 업무가 여럿이면 업무마다 따로 보고하라고 적는다", async () => {
    const t = setup();
    const a = t.store.ensureSourceTask({ projectId: t.project.id, sourceRef: "t:a", title: "환불", origin: "owner" }).task;
    const b = t.store.ensureSourceTask({ projectId: t.project.id, sourceRef: "t:b", title: "정산", origin: "owner" }).task;
    const one = t.store.enqueue({ projectId: t.project.id, memberId: t.w.id, kind: "instruction", text: "환불", taskId: a.id });
    const two = t.store.enqueue({ projectId: t.project.id, memberId: t.w.id, kind: "instruction", text: "정산", taskId: b.id });
    const turnTasks = (ds: Delivery[]) => (t.orch as unknown as { turnTasks(d: Delivery[]): string[] }).turnTasks(ds);
    expect(turnTasks([one])).toEqual([a.id]);
    expect(turnTasks([one, two, one])).toEqual([a.id, b.id]);
    await t.orch.shutdown();
  });

  test("총괄이 근거 없이 쓴 글(턴 마지막 글)은 첫 줄로 새 업무를 만들어 붙는다", async () => {
    const t = setup();
    const fallback = (t.orch as unknown as { fallbackReport(m: unknown, text: string, direct: boolean, ds?: Delivery[]): Promise<void> }).fallbackReport.bind(t.orch);
    await fallback(t.lead, "판을 정리했습니다\n세부", false, []);
    const m = t.store.listMessages(t.project.id).find((x) => x.body.startsWith("판을 정리했습니다"))!;
    expect(t.store.requireTask(m.taskId!)).toMatchObject({ title: "판을 정리했습니다", origin: "auto" });
    await t.orch.shutdown();
  });
});

describe("업무를 정할 수 없는 서버 글", () => {
  type Priv = {
    memberNotice(m: unknown, body: string, ds?: Delivery[]): void;
    fallbackReport(m: unknown, text: string, direct: boolean, ds?: Delivery[]): Promise<void>;
  };
  const two = () => {
    const t = setup();
    const p = t.orch as unknown as Priv;
    const a = t.store.ensureSourceTask({ projectId: t.project.id, sourceRef: "t:a", title: "환불", origin: "owner" }).task;
    const b = t.store.ensureSourceTask({ projectId: t.project.id, sourceRef: "t:b", title: "정산", origin: "owner" }).task;
    const give = (memberId: string, taskId: string, wake = true, kind: Delivery["kind"] = "instruction") =>
      t.store.enqueue({ projectId: t.project.id, memberId, kind, text: `일 ${taskId}`, taskId, wake, status: "held", holdReason: "시험" });
    const inTask = (taskId: string) => t.store.listMessages(t.project.id, { limit: 500 }).filter((m) => m.taskId === taskId);
    return { ...t, p, a, b, give, inTask };
  };

  test("서버 알림(대화의 시스템 줄)은 그 실행이 받은 업무에 붙고, 정할 수 없으면 직원의 '세션 알림' 업무에 한 번만 남는다", async () => {
    const t = two();
    const dA = t.give(t.w.id, t.a.id), dB = t.give(t.w.id, t.b.id), quietB = t.give(t.w.id, t.b.id, false);
    t.p.memberNotice(t.w, "철수 오류: 하나", [dA]);
    expect(t.inTask(t.a.id).map((m) => m.body)).toEqual(["철수 오류: 하나"]);
    // 함께 묶여 온 조용한 안내(wake=false)는 업무를 가르지 않는다
    t.p.memberNotice(t.w, "철수 오류: 둘", [dA, quietB]);
    expect(t.inTask(t.a.id).map((m) => m.body)).toEqual(["철수 오류: 하나", "철수 오류: 둘"]);
    // 근거가 없으면(재시작·편입 해제 등) 직원의 세션 알림 업무. 두 번째도 같은 업무다
    t.p.memberNotice(t.w, "서버 재시작으로 철수의 턴이 끊겼습니다");
    const notice = t.store.listTasks(t.project.id).find((x) => x.origin === "server")!;
    expect(notice).toMatchObject({ title: "철수 세션 알림", memberId: null });
    const tasks = t.store.listTasks(t.project.id).length;
    t.p.memberNotice(t.w, "철수: 칸을 잃었습니다");
    // 업무가 둘인 실행: 어느 한쪽에 붙이거나 둘에 복사하지 않고 세션 알림 업무에 한 번, 받은 업무를 적는다
    t.p.memberNotice(t.w, "철수: 실행 r1 중단", [dA, dB]);
    expect(t.store.listTasks(t.project.id)).toHaveLength(tasks);
    const inNotice = t.inTask(notice.id);
    expect(inNotice.map((m) => m.body.split("\n")[0])).toEqual(["서버 재시작으로 철수의 턴이 끊겼습니다", "철수: 칸을 잃었습니다", "철수: 실행 r1 중단"]);
    expect(inNotice.at(-1)!.body).toContain(`받은 업무: #${t.a.id} '환불', #${t.b.id} '정산'`);
    expect(t.inTask(t.b.id)).toHaveLength(0);
    // 대표에게 보이는 시스템 줄 가운데 업무 없는 것은 없다
    expect(t.store.listMessages(t.project.id, { limit: 500 }).filter((m) => m.kind === "시스템" && !m.taskId)).toHaveLength(0);
    // 본사는 업무를 쓰지 않는다
    const root = t.store.createMember({ projectId: "hq", kind: "root", name: "본사 AI", handle: "root", role: "본사" } as never);
    t.p.memberNotice(root, "본사 AI 오류: x");
    expect(t.store.listMessages("hq").find((m) => m.body === "본사 AI 오류: x")!.taskId).toBeNull();
    await t.orch.shutdown();
  });

  test("턴 마지막 글(자동 보고)은 한 번만 남는다. A·B 를 함께 받은 턴의 글은 A·B 어느 대화에도 복사하지 않고 직원의 '여러 업무 결과' 업무에 둔다", async () => {
    const t = two();
    const dA = t.give(t.w.id, t.a.id), dB = t.give(t.w.id, t.b.id), quietB = t.give(t.w.id, t.b.id, false);
    const reports = () => t.store.listDeliveries(t.project.id).filter((d) => d.memberId === t.lead.id && d.kind === "report");
    // A 를 받고, B 의 조용한 안내가 함께 묶인 턴: A 의 결과다
    await t.p.fallbackReport(t.w, "환불 끝냈습니다", false, [dA, quietB]);
    expect(t.inTask(t.a.id).map((m) => m.body)).toEqual(["환불 끝냈습니다"]);
    expect(reports()).toHaveLength(1);
    // A·B 지시를 함께 받은 턴: 글 하나, 총괄 보고 하나. A·B 대화에는 없다
    await t.p.fallbackReport(t.w, "환불은 됐고 정산은 보는 중", false, [dA, dB]);
    const mixed = t.store.listMessages(t.project.id, { limit: 500 }).filter((m) => m.body.startsWith("환불은 됐고 정산은 보는 중"));
    expect(mixed).toHaveLength(1);
    const mixedTask = t.store.requireTask(mixed[0]!.taskId!);
    expect(mixedTask).toMatchObject({ title: "철수 여러 업무 결과", origin: "server" });
    expect(mixed[0]!.body).toContain(`받은 업무: #${t.a.id} '환불', #${t.b.id} '정산'`);
    expect(t.inTask(t.a.id).map((m) => m.body)).toEqual(["환불 끝냈습니다"]);
    expect(t.inTask(t.b.id)).toHaveLength(0);
    expect(reports()).toHaveLength(2);
    expect(reports().at(-1)!.text).toContain(`받은 업무: #${t.a.id}, #${t.b.id}`);
    // 같은 직원의 다음 섞인 턴도 같은 업무(업무가 늘지 않는다)
    const tasks = t.store.listTasks(t.project.id).length;
    await t.p.fallbackReport(t.w, "둘 다 마무리 중", false, [dB, dA]);
    expect(t.store.listTasks(t.project.id)).toHaveLength(tasks);
    expect(t.inTask(mixedTask.id)).toHaveLength(2);
    // 총괄이 두 업무의 보고를 받고 쓴 글도 한 번만
    const rA = t.give(t.lead.id, t.a.id, true, "report"), rB = t.give(t.lead.id, t.b.id, true, "report");
    await t.p.fallbackReport(t.lead, "두 보고를 판에 적었습니다", false, [rA, rB]);
    const lead = t.store.listMessages(t.project.id, { limit: 500 }).filter((m) => m.body.startsWith("두 보고를 판에 적었습니다"));
    expect(lead).toHaveLength(1);
    expect(t.store.requireTask(lead[0]!.taskId!)).toMatchObject({ title: "총괄 여러 업무 결과", origin: "server" });
    await t.orch.shutdown();
  });
});

describe("옛 글 정리(계획·적용·되돌리기)", () => {
  function legacy() {
    const t = setup();
    const s = t.store;
    const p = t.project.id;
    const A = s.saveTask({ projectId: p, memberId: t.w.id, who: t.w.name, title: "환불", branch: "feat/refund" }).task;
    // 업무가 붙기 전의 옛 글들
    const owner = s.createMessage({ projectId: p, mine: true, who: "나", kind: "나", body: "로그인 오류 봐 줘\n자세히는" });
    const fA = s.createFile({ projectId: p, title: "환불표", who: t.w.name, memberId: t.w.id, taskId: A.id });
    const viaFile = s.createMessage({ projectId: p, memberId: t.w.id, who: t.w.name, kind: "알림", title: "표 올림", fileId: fA.id });
    const dec = s.createDecision({ projectId: p, memberId: t.w.id, who: t.w.name, title: "로그인 방식?", detail: "", options: [] } as never);
    const question = s.createMessage({ projectId: p, memberId: t.w.id, who: t.w.name, kind: "질문", title: "로그인 방식?", decisionId: dec.id });
    const lonely = s.createMessage({ projectId: p, memberId: t.w.id, who: t.w.name, kind: "진행", title: "혼자 남은 글" });
    const sys = s.createMessage({ projectId: p, who: "시스템", kind: "시스템", body: "서버 알림" });
    return { ...t, A, owner, fA, viaFile, dec, question, lonely, sys };
  }

  test("증거가 있으면 기존 업무, 없으면 새 업무로 나누고 시스템 글은 남긴다. 원문은 그대로이고 두 번 적용해도 업무가 늘지 않으며, 되돌리면 처음과 같다", () => {
    const t = legacy();
    const p = t.project.id;
    const snapshot = () => t.store.db.query("SELECT id, at, mine, member_id, who, kind, title, body, decision_id, file_id FROM messages ORDER BY id").all();
    const tasksOf = () => t.store.db.query("SELECT id, task_id FROM messages UNION ALL SELECT id, task_id FROM decisions ORDER BY id").all();
    const before = { originals: snapshot(), tasks: tasksOf(), taskCount: t.store.listTasks(p).length };

    const plan = planTaskBackfill(t.store, p);
    const item = (id: string) => plan.items.find((i) => i.refId === id)!;
    expect(item(t.viaFile.id)).toMatchObject({ action: "link", taskId: t.A.id, basis: "file" });
    expect(item(t.sys.id)).toMatchObject({ action: "leave", basis: "system" });
    expect(item(t.owner.id)).toMatchObject({ action: "new" });
    // 질문 글과 그 결재는 한 새 업무
    expect(item(t.question.id).group).toBe(item(t.dec.id).group);
    expect(item(t.lonely.id).group).not.toBe(item(t.owner.id).group);
    expect(plan.groups.find((g) => g.key === item(t.owner.id).group)!.title).toBe("로그인 오류");
    // 기존 업무 '환불'로 짐작해 넣지 않는다(이름·시각만으로는)
    expect(plan.items.filter((i) => i.action === "link").map((i) => i.refId)).toEqual([t.viaFile.id]);

    const applied = applyTaskBackfill(t.store, plan);
    expect(applied.skipped).toEqual([]);
    expect(snapshot()).toEqual(before.originals);
    expect(t.store.getMessage(t.viaFile.id)!.taskId).toBe(t.A.id);
    expect(t.store.getMessage(t.sys.id)!.taskId ?? null).toBeNull();
    expect(t.store.getMessage(t.owner.id)!.taskId).toBeTruthy();
    expect(t.store.requireTask(t.store.getMessage(t.owner.id)!.taskId!)).toMatchObject({ origin: "backfill", title: "로그인 오류" });
    expect(t.store.listTaskLinks(p, { refType: "message", refId: t.viaFile.id })).toEqual([expect.objectContaining({ fromTaskId: null, toTaskId: t.A.id, basis: "backfill-file", batchId: applied.batchId })]);

    // 같은 계획을 다시 적용해도 아무것도 바뀌지 않는다
    const count = t.store.listTasks(p).length;
    const second = applyTaskBackfill(t.store, plan);
    expect(second).toMatchObject({ linked: 0, createdTasks: 0 });
    expect(t.store.listTasks(p)).toHaveLength(count);

    // 적용 뒤 사람이 다시 바꾼 기록은 되돌리기가 덮지 않는다
    t.store.moveRecordTask({ projectId: p, refType: "message", refId: t.lonely.id, from: t.store.getMessage(t.lonely.id)!.taskId ?? null, to: t.A.id, basis: "classify", actor: t.lead.id });
    const undone = undoTaskBackfill(t.store, p, applied.batchId);
    expect(undone.conflicts).toEqual([{ refType: "message", refId: t.lonely.id, now: t.A.id }]);
    expect(snapshot()).toEqual(before.originals);
    const after = tasksOf() as { id: string; task_id: string | null }[];
    const expected = (before.tasks as { id: string; task_id: string | null }[]).map((r) => (r.id === t.lonely.id ? { ...r, task_id: t.A.id } : r));
    expect(after).toEqual(expected);
    // 그 묶음이 만든 업무는 되돌린 뒤 비었으면 지운다(혼자 남은 글이 사람 손으로 옮겨 가 빈 업무도 지운다)
    expect(undone.keptTasks).toEqual([]);
    expect(t.store.listTasks(p)).toHaveLength(before.taskCount);
  });

  test("이주: 옛 업무에는 생긴 곳(origin)이 붙고, 이 이주는 마지막 판이다", () => {
    const t = setup();
    expect(t.store.db.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
    const item = t.store.upsertWork({ projectId: t.project.id, sec: "doing", title: "판 일" });
    expect(t.store.requireTask(Store.workTaskId(item.id)).origin).toBe("board");
    const staff = t.store.saveTask({ projectId: t.project.id, memberId: t.w.id, who: t.w.name, title: "직원 일" }).task;
    expect(staff.origin).toBe("staff");
  });
});
