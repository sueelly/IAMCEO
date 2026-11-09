import { useEffect, useSyncExternalStore } from "react";
import type { Member } from "@shared/types";
import { api, getCredentialGeneration } from "./api";
import { applyLocal, getState, newId, onLogout, onSessionInvalidated, sendMessage, useProject, useStore } from "./store";
import { SubmissionManager } from "./submissions";

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
