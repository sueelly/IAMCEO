import type { ServerCapabilities, SyncRevisions } from "@shared/operations";
import type { Effort, PermissionMode, Rank, Settings, SettingsPatch, Todo } from "@shared/types";

export interface WriteContext {
  auth: string;
  credentialGeneration: number;
  projectId: string | null;
  syncProjectId: string | null;
  capabilities: ServerCapabilities | null;
  syncRevisions: SyncRevisions | null;
}
type Scope = { kind: "settings" } | { kind: "member" | "todo"; projectId: string; id: string } | { kind: "decision"; projectId: string; updatedAt: string };
export class ReviewRequiredError extends Error {}
export interface WriteReview { mode: "strict" | "legacy" | "unavailable"; version: number | string | null; credentialGeneration: number; projectId: string | null }
export type NumberKey = "maxConcurrentTurns" | "compactAtPct" | "maxAwakeWorkers";
export interface RankDraft { model?: string | null; custom?: boolean; effort?: Effort | null }
export interface SettingsDraft { permissionMode?: PermissionMode; notifyMac?: boolean; boardTidyHours?: number; numbers: Partial<Record<NumberKey, string>>; ranks: Partial<Record<Rank, RankDraft>> }
/** A review is immutable: a later snapshot cannot lend its revision to an older edit. */
export function captureWriteReview(context: WriteContext, scope: Scope): WriteReview {
  const operations = context.capabilities?.capabilities.operations;
  const projectId = scope.kind === "settings" ? null : scope.projectId;
  const base = { credentialGeneration: context.credentialGeneration, projectId };
  if (operations === false) return { ...base, mode: "legacy", version: null };
  if (operations !== true || context.auth !== "ok" || (projectId !== null && (context.projectId !== projectId || context.syncProjectId !== projectId))) return { ...base, mode: "unavailable", version: null };
  const revisions = context.syncRevisions;
  const version = scope.kind === "decision" ? scope.updatedAt
    : scope.kind === "settings" ? revisions?.settings
    : scope.kind === "member" ? revisions?.members[scope.id]?.configRevision
    : revisions?.todos[scope.id];
  const valid = typeof version === "string" ? version.length > 0 : Number.isSafeInteger(version) && version! >= 0;
  return { ...base, mode: valid ? "strict" : "unavailable", version: version ?? null };
}

export function reviewStillCurrent(review: WriteReview, context: WriteContext): boolean {
  return context.auth === "ok" && review.credentialGeneration === context.credentialGeneration
    && (review.projectId === null || context.projectId === review.projectId);
}

/** Deliberately one call; neither transport failure nor 409 may weaken a strict write. */
export async function executeReviewedWrite<T>(review: WriteReview, context: WriteContext, strict: (version: number | string) => Promise<T>, legacy: () => Promise<T>): Promise<T> {
  if (!reviewStillCurrent(review, context)) throw new ReviewRequiredError("화면이 바뀌었습니다. 현재 내용을 다시 확인해 주세요");
  if (review.mode === "legacy" && context.capabilities?.capabilities.operations === false) return legacy();
  if (review.mode === "strict" && review.version !== null && context.capabilities?.capabilities.operations === true
    && (review.projectId === null || context.syncProjectId === review.projectId)) return strict(review.version);
  throw new ReviewRequiredError("최신 상태를 확인한 뒤 다시 검토해 주세요");
}

export function startSettingsReview(base: Settings, context: WriteContext): { base: Settings; write: WriteReview } {
  return { base: structuredClone(base), write: captureWriteReview(context, { kind: "settings" }) };
}

/** Only explicitly edited leaves are sent. Untouched values never enter the patch. */
export function buildSettingsPatch(base: Settings, draft: SettingsDraft): { patch: SettingsPatch; error: string | null } {
  const patch: SettingsPatch = {};
  let error: string | null = null;
  if (draft.permissionMode !== undefined && draft.permissionMode !== base.permissionMode) patch.permissionMode = draft.permissionMode;
  if (draft.notifyMac !== undefined && draft.notifyMac !== base.notifyMac) patch.notifyMac = draft.notifyMac;
  if (draft.boardTidyHours !== undefined && draft.boardTidyHours !== base.boardTidyHours) patch.boardTidyHours = draft.boardTidyHours;
  const limits = { maxConcurrentTurns: ["전체 동시 실행", 1, 64], compactAtPct: ["압축 기준", 1, 100], maxAwakeWorkers: ["직원 상한", 1, 256] } as const;
  for (const key of Object.keys(draft.numbers) as NumberKey[]) {
    const text = draft.numbers[key]!.trim();
    const value = Number(text);
    const [label, min, max] = limits[key];
    if (!text || !Number.isInteger(value) || value < min || value > max) error ??= `${label}은 ${min}부터 ${max}까지의 정수입니다`;
    else if (value !== base[key]) patch[key] = value;
  }
  for (const rank of Object.keys(draft.ranks) as Rank[]) {
    const d = draft.ranks[rank]!;
    const change: { model?: string | null; effort?: Effort | null } = {};
    if (d.model !== undefined) {
      const model = d.model?.trim() || null;
      if (d.custom && !model) error ??= "모델 이름을 넣어 주세요";
      if (model !== base.ranks[rank].model) change.model = model;
    }
    if (d.effort !== undefined && d.effort !== base.ranks[rank].effort) change.effort = d.effort;
    if (Object.keys(change).length) patch.ranks = { ...patch.ranks, [rank]: change };
  }
  return { patch, error };
}

export function sameDecisionReview(reviewed: readonly { id: string; updatedAt: string }[], current: readonly { id: string; updatedAt: string }[]): boolean {
  if (reviewed.length !== current.length) return false;
  const versions = new Map(reviewed.map(d => [d.id, d.updatedAt]));
  return current.every(d => versions.has(d.id) && versions.get(d.id) === d.updatedAt);
}

/** The row must still be our exact optimistic object; a fresh snapshot owns any replacement. */
export function rollbackTodo(current: Todo | undefined, optimistic: Todo, before: Todo): Todo | null {
  return current === optimistic ? before : null;
}
