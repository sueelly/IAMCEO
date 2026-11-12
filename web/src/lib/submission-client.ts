import { useEffect, useSyncExternalStore } from "react";
import type { Member, Task } from "@shared/types";
import { api, getCredentialGeneration } from "./api";
import { applyLocal, getState, newId, onLogout, onSessionInvalidated, sendMessage, useProject, useStore } from "./store";
import { SubmissionManager } from "./submissions";
import { taskTarget } from "./tasks";

// Reading window.localStorage itself can throw under browser privacy settings.
const storage: Storage = {
  get length() { return localStorage.length; },
  key: (index) => localStorage.key(index),
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
  clear: () => localStorage.clear(),
};
const managers = new Set<SubmissionManager>();
const directManagers = new Map<string, SubmissionManager>();
function createManager(member?: Pick<Member, "id" | "kind" | "name">): SubmissionManager {
  const manager = new SubmissionManager({
    storage,
    host: location.origin,
    direct: member ? { memberId: member.id, targetMemberId: member.kind === "worker" ? member.id : null, targetName: member.name } : undefined,
    session: getCredentialGeneration,
    newId,
    lookup: (id) => api.message(id),
    send: (attempt) => {
      const current = getState();
      if (current.auth !== "ok" || current.project?.project.id !== attempt.projectId) return Promise.reject(new Error("원래 프로젝트를 연 뒤 다시 시도해 주세요"));
      return sendMessage(
        { ...attempt.payload, attachmentIds: [...attempt.payload.attachmentIds] },
        { targetName: attempt.targetName, attachments: [...attempt.attachments], onRejected: (error) => error.status === 409 && /연결|실행기/.test(error.message) },
      );
    },
    accepted: (message) => {
      const project = getState().project;
      if (project?.project.id !== message.projectId) return;
      const current = project.messages.find((m) => m.id === message.id);
      if (message.delivery === "queued" && current?.delivery && current.delivery !== "queued" && current.delivery !== "failed") return;
      applyLocal({ type: "message", message });
    },
  });
  managers.add(manager);
  return manager;
}
export const submissions = createManager();
export function memberSubmissions(member: Pick<Member, "id" | "projectId" | "kind" | "name">): SubmissionManager {
  const key = JSON.stringify([member.projectId, member.id]);
  let manager = directManagers.get(key);
  if (!manager) { manager = createManager(member); directManagers.set(key, manager); }
  return manager;
}
onSessionInvalidated(() => { for (const manager of managers) manager.invalidate(); });
onLogout(() => { for (const manager of managers) manager.clear(); });
window.addEventListener("storage", () => { for (const manager of managers) manager.refreshStoredAttempts(); });

/**
 * 대화의 작업 고르기. 입력칸 위 작업 칩과 대화 글의 작업 표지가 같이 쓴다(보는 글과 보낼 작업이 늘 같다).
 * 작업을 고르면 받는 사람은 그 작업을 등록한 직원, '전체'로 돌아오면 기본(총괄)이다. 작업 없이 직원만 골라 둔 상태에서 '전체'면 그대로 둔다.
 * 이미 보낸 시도는 보낸 순간의 작업을 따로 들고 있어 여기서 바뀌지 않는다.
 */
export function chooseTask(projectId: string, next: Task | null, workers: readonly Pick<Member, "id" | "name">[], manager = submissions): void {
  if (!next) manager.patchDraft(projectId, (d) => (d.taskId ? { ...d, taskId: null, targetId: null } : d));
  // 진행판 작업은 지금 고른 직원이 그 작업의 담당이면 그 직원에게 그대로 보낸다(→ taskTarget)
  else manager.patchDraft(projectId, (d) => ({ ...d, taskId: next.id, targetId: taskTarget(next, workers, d.targetId ?? null) }));
}

/** Shared by the bottom composer and member-detail direct input. Reopening either
 * checks stored IDs; it never automatically replays the captured POST request. */
export function useSubmissionDraft(projectId: string, manager = submissions) {
  const state = useSyncExternalStore(manager.subscribe, () => manager.snapshot(projectId));
  const auth = useStore((s) => s.auth);
  const connection = useStore((s) => s.connection);
  const open = useProject();
  const project = open?.project.id === projectId ? open : null;
  useEffect(() => {
    const reconcile = () => {
      if (getState().auth === "ok" && document.visibilityState === "visible") void manager.reconcile(projectId);
    };
    reconcile();
    window.addEventListener("online", reconcile);
    window.addEventListener("pageshow", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      window.removeEventListener("online", reconcile);
      window.removeEventListener("pageshow", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [projectId, manager, auth, connection]);
  useEffect(() => { if (project) manager.observe(projectId, project.messages); }, [projectId, manager, project?.messages]);
  return state;
}
