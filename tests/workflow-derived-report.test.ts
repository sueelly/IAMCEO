import { expect, test } from "bun:test";
import { fixture, until } from "./fixtures/harness-fixture.ts";

const contract = { kind: "other" as const, goal: "Return the requested answer", acceptance: ["Answer is verified"], checks: ["other" as const] };
const cases = [
  { name: "accepted inherited child completion", relation: "child", kind: "완료", closes: true },
  { name: "sibling completion sharing the same contract", relation: "sibling", kind: "완료", closes: false },
  { name: "unrelated completion", relation: "unrelated", kind: "완료", closes: false },
  { name: "descendant completion with its own contract", relation: "different_contract", kind: "완료", closes: false },
  { name: "descendant question", relation: "child", kind: "질문", closes: false },
  { name: "descendant blocked report", relation: "child", kind: "막힘", closes: false },
] as const;

for (const ending of ["turn_end", "terminal_exit"] as const) {
  test.each(cases)(`${ending} uses only the received task's accepted completion: $name`, async scenario => {
    const f = fixture();
    const root = f.orch.saveTask(f.lead, { title: "Assigned contract root", contract }).task;
    const received = scenario.relation === "sibling" ? f.orch.saveTask(f.lead, { title: "Received sibling", parentTaskId: root.id }).task : root;
    const reported = f.orch.saveTask(f.lead, { title: "Reported task",
      ...(scenario.relation !== "unrelated" ? { parentTaskId: root.id } : {}),
      ...(["different_contract", "unrelated"].includes(scenario.relation) ? { contract } : {}),
    }).task;
    await f.orch.assign(f.project.id, f.worker.handle, { text: "Perform the assigned task", taskId: received.id });
    await until("received run", () => f.store.listPendingExecutions().some(r => r.memberId === f.worker.id));
    const run = f.store.listPendingExecutions().find(r => r.memberId === f.worker.id)!;
    const report = await f.orch.recordPost(f.worker, { taskId: reported.id, kind: scenario.kind, title: "Reported result", contractRev: 1,
      checks: [{ kind: "other", name: "Verified answer", result: "pass", evidence: "Isolated fixture verification", criterion: 1 }],
    });
    if (scenario.kind === "완료") expect(f.store.getReportHarness(report.id)?.gate).toBe("contract");
    if (ending === "turn_end") f.runner.end(f.worker, 1);
    else f.runner.callback({ type: "status", memberId: f.worker.id, status: "gone", terminalId: run.identity.terminalId, sessionGeneration: run.identity.sessionGeneration });
    await until("ended run", () => !!f.store.getExecutionJournal(run.runId)?.endedAt);
    if (ending === "turn_end") {
      const followup = f.store.getReportFollowup(run.runId);
      if (scenario.closes) expect(followup).toBeNull();
      else {
        expect(followup).not.toBeNull();
        expect(f.store.deliveryTaskId(followup!.deliveryId)).toBe(received.id);
      }
    } else expect(f.store.getExecutionJournal(run.runId)?.result).toBe(scenario.closes ? "success" : "interrupted");
  });
}
