import { useEffect, useId, useRef, useState } from "react";
import type { ProjectState } from "@shared/types";
import type { WorkflowAssignmentPreview, WorkflowAssignmentRequest, WorkflowAssignmentResult } from "@shared/workflow";
import { GlassButton } from "../glass";
import { api, ApiError, errorText, getCredentialGeneration } from "../lib/api";
import { getState, routeHash, useStore } from "../lib/store";
import { chooseTask } from "../lib/submission-client";
import { Markdown, Modal, MQ_DESKTOP, Sheet, Time, useMediaQuery } from "./ui";

const CHECK_LABEL: Record<string, string> = { behavior: "관련 동작 시험", typecheck: "코드 검사", regression: "회귀 시험", real: "실제 화면·실행 증거", source: "주장별 원문 출처", fact: "사실과 해석 구분", unverified: "미확인 항목", other: "기타 검사" };

export default function WorkflowAssignment({ state, taskId, initialMemberId, onClose }: { state: ProjectState; taskId: string; initialMemberId: string | null; onClose: () => void }) {
  const projectId = state.project.id, online = useStore(s => s.connection === "online");
  const assigneeId = useId();
  const [memberId, setMemberId] = useState(initialMemberId ?? "");
  const [preview, setPreview] = useState<WorkflowAssignmentPreview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<WorkflowAssignmentRequest | null>(null);
  const [result, setResult] = useState<WorkflowAssignmentResult | null>(null);
  const [refresh, setRefresh] = useState(0);
  const lifetime = useRef(true), generation = useRef(getCredentialGeneration()), inFlight = useRef(false);
  const Overlay = useMediaQuery(MQ_DESKTOP) ? Modal : Sheet;
  const current = () => lifetime.current && getCredentialGeneration() === generation.current && getState().project?.project.id === projectId;
  useEffect(() => { lifetime.current = true; return () => { lifetime.current = false; }; }, []);
  useEffect(() => {
    setPreview(null); setError(null);
    if (!memberId || !online || !current()) { setBusy(false); return; }
    const abort = new AbortController(); setBusy(true);
    api.workflowAssignmentPreview(projectId, taskId, memberId, abort.signal).then(value => {
      if (!abort.signal.aborted && current() && value.projectId === projectId && value.task.id === taskId && value.member.id === memberId) setPreview(value);
    }).catch(e => { if (!abort.signal.aborted && current()) setError(errorText(e)); })
      .finally(() => { if (!abort.signal.aborted && current()) setBusy(false); });
    return () => abort.abort();
  }, [projectId, taskId, memberId, refresh, online]);

  const acceptResult = (value: WorkflowAssignmentResult, request: WorkflowAssignmentRequest) => {
    if (value.operationId !== request.operationId || value.projectId !== projectId || value.taskId !== taskId || value.memberId !== request.memberId) throw new Error("배정 결과의 대상이 다릅니다. 결과를 다시 확인해 주세요");
    if (current()) { setResult(value); setError(null); }
  };
  const confirm = async () => {
    if (inFlight.current || busy || pending || !online || !current() || !preview || preview.blockers.length || preview.member.id !== memberId) return;
    const request = { operationId: crypto.randomUUID(), memberId, revision: preview.revision };
    inFlight.current = true; setBusy(true); setError(null); setPending(request);
    try { acceptResult(await api.assignWorkflow(projectId, taskId, request), request); }
    catch (e) {
      if (!current()) return;
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) { setPending(null); setPreview(null); setError(errorText(e)); }
      else setError("배정 응답을 확인하지 못했습니다. 저장된 결과를 확인해 주세요");
    } finally { inFlight.current = false; if (current()) setBusy(false); }
  };
  const checkResult = async () => {
    if (!pending || busy || inFlight.current || !online || !current()) return;
    inFlight.current = true; setBusy(true);
    try { acceptResult(await api.workflowAssignmentReceipt(projectId, pending.operationId), pending); }
    catch (e) { if (current()) setError(errorText(e)); }
    finally { inFlight.current = false; if (current()) setBusy(false); }
  };
  const footer = result ? <GlassButton size="m" onClick={onClose}>닫기</GlassButton> : <>
    <GlassButton variant="ghost" size="m" onClick={onClose}>{pending ? "닫기" : "취소"}</GlassButton>
    {pending ? <GlassButton variant="primary" size="m" disabled={busy || !online} onClick={() => void checkResult()}>결과 확인</GlassButton>
      : <GlassButton variant="primary" size="m" disabled={busy || !online || !preview || !!preview.blockers.length} onClick={() => void confirm()}>배정</GlassButton>}
  </>;
  return <Overlay open title="업무 배정" onClose={onClose} footer={footer}>
    <div className="wf-assignment">
      <h3>{state.tasks?.find(t => t.id === taskId)?.title ?? "업무"}</h3>
      {result ? <p className="wf-success" role="status">{state.members.find(m => m.id === result.memberId)?.name ?? "직원"}에게 다음 업무로 배정했습니다.</p> : <>
        <div className="wf-assignee"><label htmlFor={assigneeId}>담당 직원</label><select id={assigneeId} value={memberId} disabled={busy || !!pending} onChange={e => setMemberId(e.target.value)}>
          <option value="">직원 선택</option>{state.members.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}
        </select></div>
        {!online ? <p className="wf-error" role="alert">연결을 확인한 뒤 배정할 수 있습니다.</p> : null}
        {busy ? <p className="wf-empty" role="status">{pending ? "배정 결과 확인 중" : "인계 내용 확인 중"}</p> : null}
        {error ? <p className="wf-error" role="alert">{error}</p> : null}
        {!pending && error && memberId ? <GlassButton variant="ghost" size="s" disabled={busy || !online} onClick={() => setRefresh(n => n + 1)}>다시 검토</GlassButton> : null}
        {preview ? <>
          {preview.blockers.length ? <ul className="wf-assignment__blockers">{preview.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
          <p className="wf-assignment__position">배정 후 미완료 업무 중 {preview.position}번째<span>{preview.startCondition}</span></p>
          {preview.contract ? <>
            <section><h4>목표 · 계약 r{preview.contract.rev}</h4><p>{preview.contract.goal}</p>{preview.contract.scope ? <p className="ink-2">{preview.contract.scope}</p> : null}</section>
            <section><h4>완료 조건</h4><ol>{preview.contract.acceptance.map((s,i) => <li key={i}>{s}</li>)}</ol></section>
            {preview.contract.checks.length ? <section><h4>필수 검사</h4><ul>{preview.contract.checks.map(check => <li key={check}>{CHECK_LABEL[check] ?? check}</li>)}</ul></section> : null}
            {preview.contract.forbidden.length ? <section><h4>지켜야 할 조건</h4><ul>{preview.contract.forbidden.map((s,i) => <li key={i}>{s}</li>)}</ul></section> : null}
            {preview.contract.evidence.length ? <section><h4>확인할 근거</h4><ul>{preview.contract.evidence.map((s,i) => <li key={i}>{s}</li>)}</ul></section> : null}
          </> : null}
          <section><h4>원래 지시</h4>{preview.originals.length ? preview.originals.map(m => <details key={m.id} open={preview.originals.length === 1}><summary>{m.who} · <Time iso={m.at} /></summary><Markdown text={m.body} /></details>) : <p className="ink-2">확정된 업무 조건을 전달합니다.</p>}</section>
          {preview.reports.length ? <section><h4>최근 보고·실패 근거</h4>{preview.reports.map(m => <details key={m.id}><summary>{m.who} · {m.kind} · {m.title}</summary><Markdown text={m.body} /><Time iso={m.at} />
            {m.correctsMessageId ? <p>정정 대상: {preview.reports.find(r => r.id === m.correctsMessageId)?.title || m.correctsMessageId}</p> : null}
            {m.correctedBy.length ? <p>이후 정정: {m.correctedBy.map(id => preview.reports.find(r => r.id === id)?.title || id).join(" · ")}</p> : null}
            {m.harness ? <div className="wf-proof">
              <p>계약 r{m.harness.contractRev ?? "미확인"}{m.harness.reviewNeeded ? ` · ${m.harness.reviewNeeded}` : ""}</p>
              {m.harness.checks.map((check,i) => <article key={i}><b>{check.name} · {({pass:"통과 보고",fail:"실패",not_run:"실행 안 함"} as Record<string,string>)[check.result] ?? check.result}</b>
                {check.command ? <code>{check.command}</code> : null}<p>{check.evidence}</p>
                <small>{check.execStatus === "matched" ? `실행 기록 대조 · 종료 코드 ${check.execExit ?? "미확인"}` : check.execStatus === "unsupported" ? "실행 대조 미지원" : check.execStatus === "not_required" ? "실행 대조 대상이 아닌 검사" : "실행 대조 기록 없음"}</small>
              </article>)}
              {m.harness.claims.map((claim,i) => <article key={`claim-${i}`}><p>{claim.text}</p><p>{claim.basis === "fact" ? "사실로 보고" : "해석으로 보고"} · 의미 검토 필요</p>{claim.source ? <p>{claim.source}</p> : null}{claim.quote ? <blockquote>{claim.quote}</blockquote> : null}{claim.via ? <small>{claim.via}</small> : null}</article>)}
            </div> : null}
          </details>)}</section> : null}
          {preview.files.length || preview.attachments.length ? <section><h4>관련 자료</h4><ul>{preview.files.map(f => <li key={f.id}>{f.title}{f.summary ? ` · ${f.summary}` : ""}</li>)}{preview.attachments.map(a => <li key={a.id}>{a.name}</li>)}</ul></section> : null}
          {preview.task.branch || preview.task.worktree ? <section><h4>작업 위치</h4><p>{preview.task.branch}</p><p>{preview.task.worktree}</p></section> : null}
          {preview.omitted.reports || preview.omitted.files ? <p className="ink-2">이전 보고 {preview.omitted.reports}건·자료 {preview.omitted.files}건은 업무 원문에서 이어 확인합니다.</p> : null}
          <a className="wf-action" href={routeHash({ projectId, tab: "thread" })} onClick={() => { chooseTask(projectId, { id: taskId }); onClose(); }}>업무 원문</a>
        </> : null}
      </>}
    </div>
  </Overlay>;
}
