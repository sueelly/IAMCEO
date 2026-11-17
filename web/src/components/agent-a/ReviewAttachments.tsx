// 검토 전체에 붙이는 그림: 어느 문장에도 달지 않고 이 검토에 통째로 붙인다. 초안에 남고 '검토 제출' 때 함께 넘어간다(정본은 바뀌지 않는다).
// 저장은 조건 저장이다: 그사이 다른 화면이 초안을 저장했으면 덮지 않고, 다시 읽은 목록을 보인다.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAReviewAttachment, AgentAReviewDraft } from "@shared/agent-a";
import { GlassButton } from "../../glass";
import { saveRequests } from "../../lib/agent-a-review";
import { ApiError, api, errorText, fetchAttachment } from "../../lib/api";
import { newId } from "../../lib/store";
import { Modal } from "../ui";
import { Thumb } from "./CommentPanel";
import { ImageDraw } from "./ImageDraw";

const TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX = 10;
export const fileBase64 = async (file: Blob): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
/** 그림 파일 하나를 Agent-A 에 올린다. 종류와 크기를 먼저 본다. */
export async function uploadImage(fileId: string, session: string, file: File): Promise<AgentAReviewAttachment> {
  if (!TYPES.includes(file.type)) throw new Error("PNG·JPEG·WebP 그림만 붙일 수 있습니다");
  if (file.size > 4 * 1024 * 1024) throw new Error("그림은 4MB 까지입니다");
  return api.agentAReview.upload(fileId, session, { name: file.name, mediaType: file.type, base64: await fileBase64(file) });
}

export function ReviewAttachments({ fileId, session, open, onClose, onCount }: {
  fileId: string;
  session: string;
  open: boolean;
  onClose: () => void;
  /** 붙인 그림 수가 바뀌었다(도구 막대의 숫자). */
  onCount: (count: number) => void;
}) {
  const [draft, setDraft] = useState<AgentAReviewDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<{ path: string; url: string; name: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const counted = useRef(onCount);
  counted.current = onCount;
  /** 같은 목록을 같은 초안 판에서 다시 저장하면 같은 요청 id 로 보낸다(저장은 됐는데 응답만 잃은 저장을 서버가 확인한다). */
  const requests = useRef(saveRequests(newId));

  const load = useCallback(async () => {
    try {
      const d = await api.agentAReview.draft(fileId, session);
      setDraft(d);
      counted.current(d.attachments.length);
    } catch (e) {
      setError(errorText(e));
    }
  }, [fileId, session]);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(null);
    void load();
  }, [open, load]);
  // 그리려고 받아 둔 그림 주소는 닫을 때 놓아 준다.
  const drawingUrl = drawing?.url ?? null;
  useEffect(() => () => {
    if (drawingUrl) URL.revokeObjectURL(drawingUrl);
  }, [drawingUrl]);

  const act = async (work: (base: AgentAReviewDraft) => Promise<AgentAReviewAttachment[] | null>): Promise<boolean> => {
    if (busy || !draft) return false;
    setBusy(true);
    setError(null);
    try {
      const next = await work(draft);
      if (next) {
        const saved = await api.agentAReview.saveAttachments(fileId, session, next, draft.revision, requests.current.id(draft.revision, next.map((x) => [x.path, x.name])));
        requests.current.done();
        setDraft(saved);
        counted.current(saved.attachments.length);
      }
      return true;
    } catch (e) {
      setError(errorText(e));
      // 다른 화면이 먼저 초안을 저장했다. 덮지 않고 그 초안의 목록을 다시 읽어 보인다.
      if (e instanceof ApiError && e.code === "AGENT_A_DRAFT_CONFLICT") await load();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const list = draft?.attachments ?? [];

  return (
    <>
      <Modal open={open} onClose={onClose} title="검토에 붙인 그림">
        <div className="aar-manage">
          <p className="aar-note">어느 문장에도 달지 않고 이 검토 전체에 붙이는 그림입니다. 초안에 남고 ‘검토 제출’ 때 함께 넘어갑니다. 정본은 바뀌지 않습니다.</p>
          {error ? <p className="aar-error" role="alert">{error}</p> : null}
          {!draft && !error ? <p className="aar-note" role="status">초안을 읽는 중…</p> : null}
          {draft ? (
            <>
              {list.length === 0 ? <p className="aar-note">붙인 그림이 없습니다.</p> : null}
              <div className="aar-attach" aria-label="검토에 붙인 그림 목록">
                {list.map((image) => (
                  <Thumb key={image.path} url={api.agentAReview.attachmentUrl(fileId, session, image.path)} name={image.name}
                    onRemove={busy ? undefined : () => void act(async (base) => base.attachments.filter((x) => x.path !== image.path))}
                    onDraw={busy ? undefined : () => {
                      setError(null);
                      fetchAttachment({ url: api.agentAReview.attachmentUrl(fileId, session, image.path) }).then((res) => res.blob()).then(
                        (blob) => setDrawing({ path: image.path, url: URL.createObjectURL(blob), name: image.name }),
                        (e) => setError(errorText(e)),
                      );
                    }} />
                ))}
              </div>
              <div className="aar-actions">
                <GlassButton variant="glass" size="s" disabled={busy || list.length >= MAX} onClick={() => input.current?.click()}>{busy ? "올리는 중" : "그림 붙이기"}</GlassButton>
                <span className="aar-card__meta">PNG·JPEG·WebP, 4MB 까지 · <span className="t-tabular">{list.length}</span> / {MAX}</span>
                <input ref={input} type="file" hidden multiple accept={TYPES.join(",")} aria-label="검토에 붙일 그림" onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (!files.length) return;
                  void act(async (base) => {
                    let next = base.attachments;
                    for (const file of files.slice(0, MAX - next.length)) {
                      const up = await uploadImage(fileId, session, file);
                      if (!next.some((x) => x.path === up.path)) next = [...next, up];
                    }
                    return next === base.attachments ? null : next;
                  });
                }} />
              </div>
            </>
          ) : null}
        </div>
      </Modal>
      <ImageDraw source={drawing ? { url: drawing.url, name: drawing.name } : null} onClose={() => setDrawing(null)}
        onSave={(file) => act(async (base) => {
          const up = await uploadImage(fileId, session, file);
          // 표시한 그림으로 바꿔 끼운다(같은 자리). 이미 같은 그림이 있으면 원래 것만 뺀다.
          const without = base.attachments.filter((x) => x.path !== up.path || x.path === drawing!.path);
          return without.flatMap((x) => (x.path === drawing!.path ? [up] : [x]));
        })} />
    </>
  );
}
