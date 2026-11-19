import { taskStageLabel } from "../shared/task-stage.ts";
import type { Message } from "../shared/types.ts";
import type { Store } from "./store.ts";

export function answerOwnerStatus(store: Store, message: Message, selectedTaskId: string | null): void {
  const projectId = message.projectId;
  const title = selectedTaskId ? store.requireTask(selectedTaskId).title : store.requireProject(projectId).name;
  const decisions = store.listOpenDecisions(projectId).filter(d => !selectedTaskId || d.taskId === selectedTaskId);
  const todos = store.listTodos(projectId).filter(t => !t.done && !t.outcome && (!selectedTaskId || t.taskId === selectedTaskId));
  const lines: string[] = [];
  if (selectedTaskId) {
    const current = store.taskProgress(selectedTaskId);
    lines.push(title + " · " + taskStageLabel(current));
    if (current.next) lines.push(current.next);
  } else {
    const counts = new Map<string, number>();
    for (const task of store.listTasks(projectId)) {
      if (task.mergedInto || !task.progress) continue;
      const stage = taskStageLabel(task.progress);
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
    }
    lines.push(counts.size ? "등록 업무 기준으로 " + Array.from(counts, ([stage, n]) => stage + " " + n + "건").join(", ") + "입니다." : "등록된 업무가 없습니다.");
  }
  lines.push("대표에게 열린 질문 " + decisions.length + "건, 대표 할 일 " + todos.length + "건입니다.");
  for (const item of [...decisions, ...todos].slice(0, 3)) lines.push("· " + item.title);
  const answer = store.createMessage({
    projectId, kind: "답변", who: "IAMCEO", title: title + " 현황", body: lines.join("\n"),
    aboutMessageId: message.id, taskId: selectedTaskId,
  });
  store.recordOwnerCommandAnswer(message.id, answer.id);
  store.setMessageDelivery(message.id, "delivered");
}
