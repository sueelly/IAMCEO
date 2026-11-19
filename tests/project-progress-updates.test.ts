import { afterEach, expect, test } from "bun:test";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import type { Member, WsEvent } from "../shared/types.ts";

const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = openDb(":memory:");
  databases.push(db);
  const bus = new Bus(), store = new Store(db, bus);
  const project = store.createProject({ name: "진행 조회", cwd: "/fixture" });
  const member = store.createMember({ projectId: project.id, handle: "author", name: "기록자", kind: "worker" });
  const task = store.ensureSourceTask({ projectId: project.id, title: "지도 수정", origin: "owner", sourceRef: "map" }).task;
  const writes: WsEvent[] = [];
  bus.subscribe(event => writes.push(event));
  function save(title: string, kind: "진행" | "상태" | "알림" = "진행", who: Member = member, taskId: string | null = task.id) {
    return store.saveCheckpoint(who, taskId, { kind, title, body: "다음 작업", contractTaskId: null, contractRev: null,
      checks: [], correctsId: null, aboutReportId: null, continuesWork: false });
  }
  return { db, bus, store, project, member, task, writes, save };
}

test("committed progress and plain status appear once in snapshots and events, rollback and acknowledgements stay out", () => {
  const { store, project, task, member, save, writes } = fixture();
  expect(() => store.transaction(() => { save("되돌린 변경"); throw Error("rollback"); })).toThrow("rollback");
  const saved = store.transaction(() => {
    const entry = save("배치 수정", "상태");
    expect(writes).toEqual([]);
    return entry;
  });
  expect(store.hasPostSince(member.id, saved.at)).toBe(false);
  const progress = save("지도 검증");
  save("보고 수신", "알림");
  const visible = writes.flatMap(e => e.type === "progressUpdate" ? [e.update] : []);
  expect(visible.map(row => row.id)).toEqual([saved.id, progress.id]);
  expect(visible[0]).toEqual({ id: saved.id, projectId: project.id, taskId: task.id, memberId: member.id, who: member.name,
    at: saved.at, title: "배치 수정", body: "다음 작업" });
  expect(store.hasPostSince(member.id, saved.at)).toBe(true);
  const snapshot = store.projectState(project.id);
  expect(snapshot.messages).toHaveLength(0);
  expect(snapshot.progressUpdates).toHaveLength(2);
  expect(snapshot.progressUpdates).toContainEqual(visible[0]);
  expect(store.projectState(project.id, { compact: true }).progressUpdates).toEqual(snapshot.progressUpdates);
  expect(store.db.query("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
});

test("project feed restores public legacy progress and the latest 30 with stable equal-time ordering", () => {
  const { store, project, task, member, save } = fixture();
  const other = store.createProject({ name: "별도 팀", cwd: "/other" });
  const colleague = store.createMember({ projectId: other.id, handle: "other", name: "별도 직원", kind: "worker" });
  save("다른 프로젝트", "상태", colleague, null);
  const old = { projectId: project.id, who: member.name, memberId: member.id, taskId: task.id, kind: "진행" as const };
  const earlier = store.createMessage({ ...old, title: "이전 진행" });
  store.createMessage({ ...old, mine: true, title: "대표 글" });
  store.createMessage({ ...old, targetMemberId: member.id, title: "개별 메시지" });
  expect(store.projectState(project.id).progressUpdates?.map(row => row.id)).toEqual([earlier.id]);
  for (let i = 0; i < 33; i++) save(`중간 결과 ${i}`);
  store.db.query("UPDATE task_checkpoints SET at='2099-01-10T00:00:01.000Z' WHERE project_id=?").run(project.id);
  const feed = store.projectState(project.id).progressUpdates!;
  expect(feed).toHaveLength(30);
  expect(feed.every(row => row.projectId === project.id && row.title.startsWith("중간 결과"))).toBe(true);
  expect(feed.map(row => row.id)).toEqual(feed.map(row => row.id).sort().reverse());
  expect(store.projectState(other.id, { compact: true }).progressUpdates?.map(row => row.title)).toEqual(["다른 프로젝트"]);
});
