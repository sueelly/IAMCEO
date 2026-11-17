import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import type { TaskContract } from "../server/harness.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

function fixture() {
  const db = openDb(":memory:"), store = new Store(db, new Bus());
  cleanups.push(() => db.close());
  const project = store.createProject({ name: "단계 조회 비용", cwd: "/fixture" });
  const member = store.createMember({ projectId: project.id, handle: "worker", name: "직원", kind: "worker" });
  let ordinal = 0, reads = 0, returnedRows = 0;
  const query = db.query.bind(db);
  db.query = ((...args: Parameters<typeof db.query>) => {
    const statement = query(...args);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "get" && key !== "all") return typeof value === "function" ? value.bind(target) : value;
      return (...params: unknown[]) => {
        reads++;
        const result = value.apply(target, params);
        returnedRows += Array.isArray(result) ? result.length : result == null ? 0 : 1;
        return result;
      };
    } });
  }) as typeof db.query;
  const task = (parentTaskId?: string) => store.ensureSourceTask({ projectId: project.id, sourceRef: `cost:${++ordinal}`, title: `업무 ${ordinal}`, origin: "owner", parentTaskId }).task;
  const contract = (taskId: string, authorKind: "owner" | "worker" = "owner") => store.saveTaskContract(taskId,
    { kind: "other", goal: "완료 근거 유지", acceptance: ["확인 완료"], checks: ["other"] },
    { author: authorKind === "owner" ? "대표" : member.name, authorMemberId: authorKind === "owner" ? null : member.id, authorKind });
  const complete = (taskId: string, bound?: TaskContract) => store.transaction(() => {
    const message = store.createMessage({ projectId: project.id, memberId: member.id, who: member.name, taskId, kind: "완료", title: "확인 완료" });
    if (bound) store.recordReportChecks(message, member, [{ name: "확인", kind: "other", result: "pass", evidence: "확인함", criterion: 1 }],
      { contractTaskId: bound.taskId, contractRev: bound.rev, gate: "contract" });
    return message;
  });
  const measure = <T>(read: () => T) => { reads = 0; returnedRows = 0; const result = read(); return { result, reads, returnedRows }; };
  return { store, project, member, task, contract, complete, measure };
}

test("업무 하나의 단계 갱신은 무관한 완료 이력이 늘어도 그 이력을 읽지 않는다", () => {
  const f = fixture(), selected = f.task();
  f.complete(selected.id, f.contract(selected.id));
  const seed = (n: number) => f.store.transaction(() => {
    for (let i = 0; i < n; i++) {
      const other = f.task();
      f.complete(other.id, f.contract(other.id));
    }
  });
  seed(20);
  const small = f.measure(() => f.store.taskProgressFacts(f.project.id, new Set([selected.id])));
  seed(40);
  const large = f.measure(() => f.store.taskProgressFacts(f.project.id, new Set([selected.id])));
  expect(large.result.size).toBe(1);
  expect(large.result.get(selected.id)?.reports[0]?.passed).toBe(true);
  expect(large.returnedRows).toBeLessThanOrEqual(small.returnedRows + 4);
});

for (const mode of ["계약 없는", "같은 부모 계약을 따르는", "각자 다른 계약을 따르는"] as const) {
  test(`${mode} 완료 기록이 늘어도 프로젝트 조회 횟수는 비례해서 늘지 않는다`, () => {
    const f = fixture();
    const parent = mode === "같은 부모 계약을 따르는" ? f.task() : null;
    const bound = parent ? f.contract(parent.id) : undefined;
    const seed = (n: number) => f.store.transaction(() => {
      for (let i = 0; i < n; i++) {
        const task = f.task(parent?.id);
        f.complete(task.id, mode === "각자 다른 계약을 따르는" ? f.contract(task.id) : bound);
      }
    });
    seed(20);
    const small = f.measure(() => f.store.projectState(f.project.id, { compact: true }));
    expect(small.result.tasks?.filter(t => t.progress?.stage === "delivered")).toHaveLength(20);
    seed(40);
    const large = f.measure(() => f.store.projectState(f.project.id, { compact: true }));
    expect(large.result.tasks?.filter(t => t.progress?.stage === "delivered")).toHaveLength(60);
    console.log("TASK_PROGRESS_READ_COST", JSON.stringify({ mode, small: small.reads, large: large.reads }));
    expect(large.reads).toBeLessThanOrEqual(small.reads + 4);
    const facts = f.store.taskProgressFacts(f.project.id);
    expect([...facts.values()].flatMap(row => row.reports).every(report => report.passed)).toBe(true);
  });
}

test("일괄 조회도 확인 전 제안보다 확정 계약을 따르고 다음 조회에는 새 계약 판을 반영한다", () => {
  const f = fixture();
  const parent = f.task(), child = f.task(parent.id), own = f.task(), draftOnly = f.task();
  const parentContract = f.contract(parent.id), ownContract = f.contract(own.id);
  f.contract(child.id, "worker");
  f.contract(own.id, "worker");
  f.contract(draftOnly.id, "worker");
  const inherited = f.complete(child.id, parentContract), direct = f.complete(own.id, ownContract), unbound = f.complete(draftOnly.id);
  const passed = () => new Map([...f.store.taskProgressFacts(f.project.id).values()].flatMap(row => row.reports.map(r => [r.id, r.passed] as const)));
  expect(passed()).toEqual(new Map([[inherited.id, true], [direct.id, true], [unbound.id, true]]));
  f.contract(parent.id);
  expect(passed()).toEqual(new Map([[inherited.id, false], [direct.id, true], [unbound.id, true]]));
});

test("일괄 완료 근거는 계약별 승계와 작성자 정정의 경계를 유지한다", () => {
  const f = fixture();
  const parent = f.task(), child = f.task(parent.id), other = f.task();
  const bound = f.contract(parent.id), otherBound = f.contract(other.id);
  const lead = f.store.createMember({ projectId: f.project.id, handle: "lead", name: "총괄", kind: "conductor" });
  const stranger = f.store.createMember({ projectId: f.project.id, handle: "stranger", name: "다른 직원", kind: "worker" });
  const original = f.complete(child.id, bound);
  const inherit = (contract: TaskContract) => f.store.transaction(() => {
    const message = f.store.createMessage({ projectId: f.project.id, memberId: lead.id, who: lead.name, taskId: contract.taskId, kind: "완료", title: "근거 승계" });
    f.store.recordReportChecks(message, lead, [], { contractTaskId: contract.taskId, contractRev: contract.rev, gate: "contract" });
    return message;
  });
  const inherited = inherit(bound), withoutSource = inherit(otherBound);
  const correct = (member: typeof f.member) => f.store.transaction(() => {
    const message = f.store.createMessage({ projectId: f.project.id, memberId: member.id, who: member.name, taskId: child.id, kind: "막힘", title: "완료 정정" });
    f.store.recordReportChecks(message, member, [{ name: "확인", kind: "other", result: "fail", evidence: "근거 철회", criterion: 1 }],
      { contractTaskId: bound.taskId, contractRev: bound.rev, gate: "contract" });
    f.store.saveReportReferences(f.project.id, { sourceMessageId: message.id, authoredAt: message.at, sequence: 1, correctsMessageId: original.id, fileIds: [], decisionIds: [] });
    return message;
  });
  const passed = () => new Map([...f.store.taskProgressFacts(f.project.id).values()].flatMap(row => row.reports.map(r => [r.id, r.passed] as const)));
  correct(stranger);
  let current = passed();
  expect([current.get(original.id), current.get(inherited.id), current.get(withoutSource.id)]).toEqual([true, true, false]);
  const correction = correct(f.member);
  current = passed();
  expect([current.get(original.id), current.get(inherited.id), current.get(withoutSource.id)]).toEqual([false, false, false]);
  expect(f.store.completionEvidence(bound.taskId, bound.rev)).toContainEqual({ messageId: original.id, eligible: false, status: "superseded", correctedBy: correction.id });
});

// Explicit author proof is part of the same bounded project read path.
test("명시 구현 소관이 늘어도 프로젝트 조회 횟수는 비례해서 늘지 않는다", () => {
  const f=fixture(),lead=f.store.createMember({projectId:f.project.id,handle:"lead",name:"총괄",kind:"conductor"});
  const seed=(n:number)=>f.store.transaction(()=>{for(let i=0;i<n;i++){
    const t=f.task(),d=f.store.enqueue({projectId:f.project.id,memberId:f.member.id,taskId:t.id,kind:"instruction",text:"명시 구현 맡김"});
    f.store.recordImplementationAssignment(t.id,d,lead,"implementation");
  }});
  seed(10);const small=f.measure(()=>f.store.taskProgressFacts(f.project.id));
  seed(20);const large=f.measure(()=>f.store.taskProgressFacts(f.project.id));
  expect([...large.result.values()].every(row=>row.implementationOwner?.memberId===f.member.id)).toBe(true);
  expect(large.reads).toBeLessThanOrEqual(small.reads+4);
});
