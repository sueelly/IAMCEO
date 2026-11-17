import { afterEach, expect, test } from "bun:test";
import { openDb } from "../server/db.ts";
import { Store } from "../server/store.ts";
import { Bus } from "../server/bus.ts";
import { describeTaskContext } from "../server/task-context.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });

test("다른 업무의 전달과 보고는 맥락으로 인용하지 않고 누락을 명시한다", () => {
  const store = new Store(openDb(":memory:"), new Bus()); stores.push(store);
  const project = store.createProject({ name: "IAMCEO", cwd: process.cwd() });
  const member = store.createMember({ projectId: project.id, handle: "reader", name: "조사", kind: "worker", origin: "runner" });
  const task = store.ensureSourceTask({ projectId: project.id, sourceRef: "mine", title: "로그인 오류 조사", origin: "owner" }).task;
  const other = store.ensureSourceTask({ projectId: project.id, sourceRef: "other", title: "이미지 수정", origin: "owner" }).task;
  const source = store.enqueue({ projectId: project.id, memberId: member.id, taskId: other.id, kind: "user_message", text: "이 내용은 다른 업무의 원문입니다" });
  store.markDelivered(source.id);
  store.createMessage({ projectId: project.id, taskId: other.id, who: member.name, memberId: member.id, kind: "막힘", title: "다른 업무의 보고", body: "공개하지 않을 다른 업무 내용" });
  const text = describeTaskContext(store, task, { sourceDeliveryId: source.id });
  expect(text).toContain("로그인 오류 조사");
  expect(text).toContain("이 업무에 연결된 요청 원문을 확인하지 못했습니다");
  expect(text).toContain("이 업무에 연결된 보고가 없습니다");
  expect(text).not.toContain(source.text);
  expect(text).not.toContain("공개하지 않을 다른 업무 내용");
});
