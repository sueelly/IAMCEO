import type { FileKind, FileListItem, FilePage } from "@shared/types";

export function compareFiles(a: FileListItem, b: FileListItem): number {
  if (a.order !== b.order) return b.order - a.order;
  const left = Array.from(a.id, c => c.codePointAt(0)!), right = Array.from(b.id, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return right[i] - left[i];
  return right.length - left.length;
}
const merge = (...lists: FileListItem[][]) => [...new Map(lists.flat().map(file => [file.id, file])).values()].sort(compareFiles);
const totalOf = (page: FilePage, kind: FileKind | null) => kind ? page.counts[kind] ?? 0 : Object.values(page.counts).reduce((sum, n) => sum + (n ?? 0), 0);

/** Reconcile the already-read interval. A changed total never proves that only the last response remains valid. */
export async function reconcileFileWindow(previous: FilePage | null, page: FilePage, cursor: string | null,
  recent: FileListItem[], scope: { taskId: string | null; kind: FileKind | null }, fetchPage: (cursor: string | null) => Promise<FilePage>): Promise<FilePage> {
  if (!previous) return page;
  const matches = (file: FileListItem) => (!scope.taskId || file.taskId === scope.taskId) && (!scope.kind || file.kind === scope.kind);
  const known = new Map(recent.map(file => [file.id, file]));
  const old = previous.items.map(file => known.get(file.id) ?? file).filter(matches);
  const oldest = old.at(-1);
  const additions = recent.filter(file => matches(file) && (!previous.hasMore || !oldest || compareFiles(file, oldest) <= 0));
  const seen = new Set<string>();
  const next = async (last: FilePage) => {
    if (!last.nextCursor || seen.has(last.nextCursor)) throw new Error("자료 목록의 위치 정보가 반복되었습니다");
    seen.add(last.nextCursor);
    return fetchPage(last.nextCursor);
  };

  let last = page, fresh = page.items;
  if (cursor === null && old.length) {
    const anchors = new Set(old.map(file => file.id));
    while (last.hasMore && !fresh.some(file => anchors.has(file.id))) {
      last = await next(last); fresh = merge(fresh, last.items);
    }
  }
  // A refresh is authoritative for the range it actually read; older intervals remain visible.
  const boundary = fresh.at(-1);
  const retained = cursor !== null ? old : last.hasMore && boundary ? old.filter(file => compareFiles(file, boundary) > 0) : [];
  let items = merge(retained, fresh, additions);
  const total = totalOf(last, scope.kind);
  if (cursor === null && !previous.hasMore && items.length < total) {
    // A previously complete list must stay complete when a moved old row is
    // outside the compact preview. Reopening a scroll sentinel can leave both
    // that row and its open reader stale, so finish the authoritative traversal.
    while (last.hasMore) {
      last = await next(last); fresh = merge(fresh, last.items);
    }
    return { ...last, items: fresh };
  }
  if (items.length > total) {
    // An unseen deletion inside an already-read page is rare. Re-read only that visible interval to prune it.
    const target = items.at(-1);
    last = cursor === null ? page : await fetchPage(null); fresh = last.items; seen.clear();
    while (last.hasMore && target && last.items.length && compareFiles(last.items.at(-1)!, target) < 0) {
      last = await next(last); fresh = merge(fresh, last.items);
    }
    items = fresh;
    return { ...last, items };
  }
  if (cursor !== null) return { ...last, items };
  if (!last.hasMore || items.length >= total) return { ...last, items, hasMore: false, nextCursor: null };
  // If a full old range gains an unseen older task binding, reopen its continuation instead of hiding the new row.
  return { ...last, items, hasMore: true, nextCursor: previous.hasMore ? previous.nextCursor ?? last.nextCursor : last.nextCursor };
}
