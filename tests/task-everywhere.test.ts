// 모든 글의 업무: 대표 글·자료·보고 보완·서버 알림이 업무 없이 남지 않고, 새 업무 이름은 비밀값·내부 번호 없이 글 첫 줄로 만든다.
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
  test("첫 내용 줄에서 주소·내부 번호·해시·경로·비밀값을 지우고 40자로 자른다", () => {
    const fb = datedTitle("대표 글", "2026-11-13T11:15:00Z");
    expect(fb).toBe("대표 글 11월 13일 20:15");
    expect(taskTitleFrom("아니 접속코드는 언제나 1118로 통일해", fb)).toBe("아니 접속코드는 언제나 …로 통일해");
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
    const long = taskTitleFrom("지금 전체 제외하고 작업 클릭했을 때 대화가 모두 없다고 떠. 작업 부여하고 관리하는 부분 한번 확인해봐", fb);
    expect([...long].length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
    expect(scrubTaskText("비밀번호: hunter22 바꿔")).toBe("비밀번호: … 바꿔");
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
    expect(plan.groups.find((g) => g.key === item(t.owner.id).group)!.title).toBe("로그인 오류 봐 줘");
    // 기존 업무 '환불'로 짐작해 넣지 않는다(이름·시각만으로는)
    expect(plan.items.filter((i) => i.action === "link").map((i) => i.refId)).toEqual([t.viaFile.id]);

    const applied = applyTaskBackfill(t.store, plan);
    expect(applied.skipped).toEqual([]);
    expect(snapshot()).toEqual(before.originals);
    expect(t.store.getMessage(t.viaFile.id)!.taskId).toBe(t.A.id);
    expect(t.store.getMessage(t.sys.id)!.taskId ?? null).toBeNull();
    expect(t.store.getMessage(t.owner.id)!.taskId).toBeTruthy();
    expect(t.store.requireTask(t.store.getMessage(t.owner.id)!.taskId!)).toMatchObject({ origin: "backfill", title: "로그인 오류 봐 줘" });
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
