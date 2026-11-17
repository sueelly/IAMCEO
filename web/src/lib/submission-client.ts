import { useEffect, useSyncExternalStore } from "react";
import type { Member, Task } from "@shared/types";
import { withTask } from "./tasks";
import { api, getCredentialGeneration } from "./api";
import { applyLocal, getState, newId, onLogout, onSessionInvalidated, sendMessage, useProject, useStore } from "./store";
import { SubmissionManager, SubmissionRefused } from "./submissions";

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
    send: async (attempt) => {
      const current = getState();
      if (current.auth !== "ok" || current.project?.project.id !== attempt.projectId) throw new Error("원래 프로젝트를 연 뒤 다시 시도해 주세요");
      // 연결 때문에 서버가 저장 전에 거부한 409 만 '거부'로 넘긴다. 이미 답한 결재 같은 다른 409·응답 유실은 그대로 결과 확인으로 간다.
      let refused: string | null = null;
      const saved = await sendMessage(
        { ...attempt.payload, attachmentIds: [...attempt.payload.attachmentIds] },
        { targetName: attempt.targetName, attachments: [...attempt.attachments], onRejected: (error) => {
          // ConnectGate 의 isGateRejection 과 같은 기준(연결 때문에 거부한 409).
          if (!(error.status === 409 && /연결|실행기/.test(error.message))) return false;
          refused = error.message;
          return true;
        } },
      );
      if (!saved && refused !== null) throw new SubmissionRefused(refused);
      return saved;
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
 * 대화의 업무 고르기. 입력칸 위 업무 칩과 대화 글의 업무 이름이 같이 쓴다(보는 글과 보낼 업무가 늘 같다).
 * 업무만 바꾼다. 받는 사람은 그대로 둔다: 한 업무를 시작·마무리하며 여러 직원과 이어서 말할 수 있다(대표 2026-11-13).
 * 이미 보낸 시도는 보낸 순간의 업무·받는 사람을 따로 들고 있어 여기서 바뀌지 않는다.
 */
export function chooseTask(projectId: string, next: Pick<Task, "id"> | null, manager = submissions): void {
  manager.patchDraft(projectId, (d) => withTask(d, next?.id ?? null));
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
