import { useCallback, useEffect, useRef, useState } from "react";
import type { FileDoc, FileKind, FilePage } from "@shared/types";
import { api, errorText, getCredentialGeneration } from "./api";
import { reconcileFileWindow } from "./file-window";

interface Feed extends Omit<FilePage, "projectId"> { key: string; loading: boolean; error: string | null }
const empty = (key: string): Feed => ({ key, items: [], counts: {}, nextCursor: null, hasMore: false, loading: true, error: null });

/** A scope change fences both initial and continuation requests; a refresh keeps already-read pages when they overlap. */
export function useFilePages(projectId: string, taskId: string | null, kind: FileKind | null, enabled: boolean, recent: FileDoc[], fileRevision = 0) {
  const key = JSON.stringify([projectId, taskId, kind, enabled]);
  const revision = JSON.stringify(recent.map(f => [f.id, f.taskId, f.kind, f.order, f.title, f.summary]));
  const recentRef = useRef(recent); recentRef.current = recent;
  const [feed, setFeed] = useState<Feed>(() => empty(key));
  const current = useRef(feed); current.current = feed;
  const active = useRef<{ key: string; controller: AbortController | null; loading: boolean; alive: boolean }>({ key, controller: null, loading: false, alive: false });
  const load = useCallback(async (cursor: string | null) => {
    const context = active.current;
    if (!enabled || !context.alive || context.key !== key || context.loading) return;
    context.loading = true;
    const controller = new AbortController(); context.controller = controller;
    const credential = getCredentialGeneration();
    const valid = () => active.current === context && context.alive && !controller.signal.aborted && credential === getCredentialGeneration();
    setFeed(s => ({ ...(s.key === key ? s : empty(key)), loading: true, error: null }));
    try {
      const fetchPage = async (position: string | null): Promise<FilePage> => {
        const page = await api.filePage(projectId, { taskId: taskId ?? undefined, kind: kind ?? undefined, cursor: position ?? undefined, limit: 20 }, controller.signal);
        if (!valid()) throw new Error("자료 조회가 취소되었습니다");
        if (page.projectId !== projectId || page.items.some(f => f.projectId !== projectId) || page.hasMore && (!page.nextCursor || page.nextCursor === position)) throw new Error("자료 목록 응답이 올바르지 않습니다");
        return page;
      };
      const page = await fetchPage(cursor);
      const previous = current.current.key === key && current.current.items.length ? { ...current.current, projectId } : null;
      const recent = recentRef.current.map(({ body: _body, ...file }) => file);
      const reconciled = await reconcileFileWindow(previous, page, cursor, recent, { taskId, kind }, fetchPage);
      if (!valid()) return;
      setFeed({ ...reconciled, key, loading: false, error: null });
    } catch (error) {
      if (valid()) setFeed(s => ({ ...(s.key === key ? s : empty(key)), loading: false, error: errorText(error) }));
    } finally { context.loading = false; }
  }, [enabled, key, projectId, taskId, kind]);
  useEffect(() => {
    const context: typeof active.current = { key, controller: null, loading: false, alive: true };
    active.current = context;
    if (enabled) void load(null);
    return () => { context.alive = false; context.controller?.abort(); };
  }, [key, revision, fileRevision, enabled, load]);
  const fresh = feed.key === key ? feed : empty(key);
  return { ...fresh, loadMore: () => load(fresh.nextCursor) };
}

export function useFileDetail(projectId: string, id: string | null, enabled: boolean) {
  const key = JSON.stringify([projectId, id]);
  const [detail, setDetail] = useState<{ key: string; file: FileDoc | null; error: string | null }>({ key, file: null, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled || !id) return;
    const controller = new AbortController(), credential = getCredentialGeneration();
    let alive = true;
    setDetail({ key, file: null, error: null });
    void api.file(id, controller.signal).then(file => {
      if (!alive || credential !== getCredentialGeneration()) return;
      if (file.projectId !== projectId) throw new Error("자료를 찾을 수 없습니다");
      setDetail({ key, file, error: null });
    }).catch(error => {
      if (alive && credential === getCredentialGeneration()) setDetail({ key, file: null, error: errorText(error) });
    });
    return () => { alive = false; controller.abort(); };
  }, [key, id, projectId, enabled, retry]);
  return { ...(detail.key === key ? detail : { key, file: null, error: null }), retry: () => setRetry(n => n + 1) };
}
