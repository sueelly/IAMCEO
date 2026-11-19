import { expect, test } from "bun:test";
import { fixture } from "./fixtures/harness-fixture.ts";

test("owner retires a sleeping runner from the roster and routing while its attributed history survives", async () => {
  const f = fixture(), w = f.worker;
  const token = f.store.getMemberToken(w.id);
  const message = f.store.createMessage({ projectId: w.projectId, memberId: w.id, who: w.name, kind: "알림", title: "원 보고" });
  const delivery = f.store.enqueue({ projectId: w.projectId, memberId: w.id, kind: "system", text: "이전 입력" });
  f.store.markDelivered(delivery.id);
  await f.orch.sleepMember(w.id);
  await f.orch.retireMember(w.id);
  await f.orch.retireMember(w.id);
  expect(f.store.getMember(w.id)).toBeNull();
  expect(f.store.getMemberByToken(token)).toBeNull();
  expect(f.store.listMembers(w.projectId).some(m => m.id === w.id)).toBe(false);
  expect(f.store.getMessage(message.id)?.memberId).toBe(w.id);
  expect(f.store.requireDelivery(delivery.id).memberId).toBe(w.id);
  expect(f.store.projectSummaries().find(p => p.id === w.projectId)?.memberCount).toBe(f.store.listMembers(w.projectId).length);
  expect(() => f.store.enqueue({ projectId: w.projectId, memberId: w.id, kind: "instruction", text: "새 지시" })).toThrow();
  const replacement = f.make(w.handle, w.name, "worker");
  expect(replacement.id).not.toBe(w.id);
});

test("retirement protects a live session, queued input, and the primary reviewer", async () => {
  const f = fixture();
  await expect(f.orch.retireMember(f.worker.id)).rejects.toThrow();
  await f.orch.sleepMember(f.worker.id);
  f.store.enqueue({ projectId:f.project.id, memberId:f.worker.id, kind:"instruction", text:"새 업무" });
  await expect(f.orch.retireMember(f.worker.id)).rejects.toThrow();
  const primary = f.store.ensureFinalReviewer(f.project.id)!;
  await expect(f.orch.retireMember(primary.id)).rejects.toThrow();
  expect(f.store.getMember(f.worker.id)).not.toBeNull();
});

test("a retired chief and standby keep their historical identity and a later need creates a separate member", async () => {
  const f = fixture();
  const standby = f.store.ensureStandbyReviewer(f.project.id)!;
  f.store.patchMember(standby.id,{status:"idle"});
  for (const m of [f.lead, standby]) {
    await f.orch.sleepMember(m.id);
    await f.orch.retireMember(m.id);
    expect(f.store.db.query("SELECT name FROM members WHERE id=?").get(m.id)).toMatchObject({ name: m.name });
  }
  expect(f.store.getConductor(f.project.id)).toBeNull();
  expect(f.store.getStandbyReviewer(f.project.id)).toBeNull();
  expect(f.store.ensureStandbyReviewer(f.project.id)!.id).not.toBe(standby.id);
  expect((await f.orch.ensureConductor(f.project.id)).id).not.toBe(f.lead.id);
});
