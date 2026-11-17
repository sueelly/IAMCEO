import { GlassButton } from '../../../web/src/glass';
import { workflowBucket, workflowCategory } from '../../../shared/workflow-view';
import type { Member, Task } from '../../../shared/types';
import type { ProjectWorkflow, WorkflowNode } from '../../../shared/workflow';
export type PreviewMember=Pick<Member,'id'|'name'|'kind'|'status'> & {role?:string;cli?:string;modelOverride?:string|null;effort?:string|null;contextPct?:number;now?:string|null;next?:string|null;queuedCount?:number;subagents?:number;updatedAt?:string;blockedReason?:string;executionIssue?:{message?:string;kind?:string}|null;deliveryWait?:{kind:string}|null;openAsks?:number};
export type Snapshot={capturedAt:string;sourceSha:string;project:{id:string;name:string;now?:string;memory?:unknown;runnerEnabled?:boolean};members:PreviewMember[];tasks:Task[];workflow:ProjectWorkflow};
export type Tab='all'|'now'|'next'|'checks'|'blocked'|'done';
export type Section='summary'|'tasks'|'activity'|'runtime';
export type Pane={kind:'member';memberId:string;section:Section;tab:Tab;expanded:string|null}|{kind:'tasks';title:string;ids:string[];expanded:string|null}|{kind:'relations';edges:ProjectWorkflow['edges']}|{kind:'members';ids:string[];title:string}|{kind:'team';section:'report'|'memory'|'legacy'|'create'};
export const selectTab=(ns:WorkflowNode[],tab:Tab)=>tab==='all'?ns:tab==='checks'?ns.filter(n=>workflowCategory(n)==='action'):tab==='blocked'?ns.filter(n=>['blocked','unknown'].includes(n.state)):ns.filter(n=>workflowBucket(n)===tab);
const tabs:[Tab,string][]=[['all','전체'],['now','지금'],['next','다음·대기'],['checks','확인 필요'],['done','완료']];
const sections:[Section,string][]=[['summary','요약'],['tasks','업무'],['activity','활동'],['runtime','실행·설정']];
const stamp=(at:string)=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'short'}).format(new Date(at));
export function Inspector({data,pane,setPane,onMember,onTask,onFocus}:{data:Snapshot;pane:Pane;setPane:(p:Pane)=>void;onMember:(id:string)=>void;onTask:(id:string)=>void;onFocus:(id:string)=>void}){
 const tasks=new Map(data.tasks.map(t=>[t.id,t])),nodes=data.workflow.nodes,byNode=new Map(nodes.map(n=>[n.id,n]));
 const member=pane.kind==='member'?data.members.find(m=>m.id===pane.memberId):null;
 const memberName=(id:string)=>data.members.find(m=>m.id===id)?.name??'이전 직원';
 const all=pane.kind==='member'?nodes.filter(n=>n.memberId===pane.memberId).sort((a,b)=>a.order-b.order):pane.kind==='tasks'?pane.ids.map(id=>nodes.filter(n=>n.taskId===id).sort((a,b)=>({blocked:0,unknown:1,running:2,starting:2,review:3,waiting:4,queued:4,done:5}[a.state])-({blocked:0,unknown:1,running:2,starting:2,review:3,waiting:4,queued:4,done:5}[b.state]))[0]).filter(Boolean):[];
 const visible=pane.kind==='member'?selectTab(all,pane.tab):all;
 const title=(id:string)=>tasks.get(id)?.title??id;
 const showTab=(tab:Tab)=>{if(pane.kind==='member')setPane({...pane,section:'tasks',tab,expanded:null})};
 const detail=(n:WorkflowNode)=>{const expanded=(pane.kind==='member'||pane.kind==='tasks')&&pane.expanded===n.id;return <article className="detail-item" key={n.id} data-expanded={expanded||undefined} data-task-id={n.taskId}>
  <button className="detail-title" onClick={()=>{if(pane.kind==='member'||pane.kind==='tasks')setPane({...pane,expanded:expanded?null:n.id})}} onContextMenu={e=>{e.preventDefault();onFocus(n.taskId)}}><span className="task-meta" data-state={n.state}>{n.label}{pane.kind==='tasks'&&<span>· {new Set(nodes.filter(x=>x.taskId===n.taskId).map(x=>x.memberId).filter(Boolean)).size}명 참여</span>}</span><strong>{title(n.taskId)}</strong><span aria-hidden="true">{expanded?'−':'+'}</span></button>
  {expanded&&<div className="detail-content">{n.reason&&<p className="reason" data-blocked={['blocked','unknown'].includes(n.state)||undefined}>{n.reason}</p>}
   <section><h3>참여 직원</h3><div className="participant-list">{nodes.filter(x=>x.taskId===n.taskId).map(x=><button key={x.id} disabled={!x.memberId} onClick={()=>x.memberId&&onMember(x.memberId)}><span>{x.memberId?memberName(x.memberId):'미배정'}</span><span className="task-meta" data-state={x.state}>{x.label}</span></button>)}</div></section>
   {n.lastActivity&&<section><h3>마지막 기록</h3><p>{n.lastActivity.title}</p><time>{stamp(n.lastActivity.at)}</time></section>}
   {tasks.get(n.taskId)?.parentTaskId&&<section><h3>부모 업무</h3><button className="text-link" onClick={()=>onTask(tasks.get(n.taskId)!.parentTaskId!)}>{title(tasks.get(n.taskId)!.parentTaskId!)}</button></section>}
   <GlassButton size="s" onClick={()=>onFocus(n.taskId)}>연결만 보기</GlassButton>
  </div>}
 </article>};
 return <>
  {pane.kind==='member'&&<>
   {Boolean(member?.openAsks)&&<button className="attention-notice" onClick={()=>setPane({...pane,section:'runtime'})}>결재 대기 {member!.openAsks}건 →</button>}
   <nav className="employee-tabs" aria-label="직원 상세 탭">{sections.map(([key,label])=><GlassButton size="s" variant="ghost" key={key} ariaPressed={pane.section===key} onClick={()=>setPane({...pane,section:key})}>{label}{key==='tasks'&&<span className="count">{all.length}</span>}</GlassButton>)}</nav>
  </>}
  {(pane.kind==='tasks'||pane.kind==='member'&&pane.section==='tasks')&&<>
   {pane.kind==='member'&&<nav className="inspector-tabs" aria-label="업무 상태">{tabs.map(([key,label])=><GlassButton size="s" variant="ghost" key={key} ariaPressed={pane.tab===key||pane.tab==='blocked'&&key==='checks'} onClick={()=>showTab(key)}>{label}<span className="count">{selectTab(all,key).length}</span></GlassButton>)}</nav>}
   <div className="inspector-list">{pane.kind==='member'&&pane.tab==='blocked'&&<p className="list-heading">막힘 {visible.length}</p>}{visible.map(detail)}{!visible.length&&<p className="empty-result">해당하는 업무가 없습니다.</p>}</div>
  </>}
  {pane.kind==='member'&&pane.section==='summary'&&<div className="inspector-list member-overview">
   <p className="member-role">{member?.role}</p>
   <div className="member-metrics">{(['now','next','blocked','done'] as Tab[]).map((tab,i)=><button key={tab} data-warn={tab==='blocked'||undefined} onClick={()=>showTab(tab)}><span>{['지금','다음·대기','막힘','완료'][i]}</span><b>{selectTab(all,tab).length}</b></button>)}</div>
   {member?.blockedReason&&<p className="reason" data-blocked>{member.blockedReason}</p>}
   {member?.executionIssue&&<p className="reason" data-blocked>{member.executionIssue.message??member.executionIssue.kind}</p>}
   {member?.deliveryWait&&<button className="delivery-notice" onClick={()=>setPane({...pane,section:'runtime'})}>전달 대기 · {({working:'진행 중인 실행',sequence:'앞선 입력',session:'세션 확인'} as Record<string,string>)[member.deliveryWait.kind]??member.deliveryWait.kind} <span>→</span></button>}
   <section className="member-section"><h3>최근 보고</h3><p>{member?.now||'등록된 보고가 없습니다.'}</p>{member?.updatedAt&&<time>{stamp(member.updatedAt)}</time>}</section>
   {member?.next&&<section className="member-section"><h3>다음 보고</h3><p>{member.next}</p></section>}
   {member?.kind==='conductor'&&data.project.now&&<section className="member-section"><h3>팀 상황</h3><p>{data.project.now}</p></section>}
   <div className="context-row"><span>문맥 {member?.contextPct??'—'}%</span><span>입력 대기 {member?.queuedCount??0}</span><span>하위 직원 {member?.subagents??0}</span></div>
  </div>}
  {pane.kind==='member'&&pane.section==='activity'&&<div className="inspector-list"><section className="member-section"><div className="section-actions"><h3>업무의 마지막 기록</h3><GlassButton size="s" disabled>터미널</GlassButton></div></section>{[...new Map(all.filter(n=>n.lastActivity).sort((a,b)=>b.lastActivity!.at.localeCompare(a.lastActivity!.at)).map(n=>[`${n.lastActivity!.at}:${n.lastActivity!.title}`,n])).values()].map(n=><article className="activity-item" key={n.id}><time>{stamp(n.lastActivity!.at)}</time><button onClick={()=>setPane({...pane,section:'tasks',tab:'all',expanded:n.id})}>{title(n.taskId)}</button><p>{n.lastActivity!.title}</p></article>)}</div>}
  {pane.kind==='member'&&pane.section==='runtime'&&<div className="inspector-list">
   <section className="member-section"><h3>실행</h3><dl className="settings-list"><dt>상태</dt><dd>{({working:'실행 중',idle:'대기',blocked:'승인·입력 확인',error:'오류',asleep:'잠듦',offline:'오프라인'} as Record<string,string>)[member?.status??'']??member?.status}</dd><dt>문맥</dt><dd>{member?.contextPct??'—'}%</dd><dt>입력 대기</dt><dd>{member?.queuedCount??0}</dd></dl><div className="runtime-actions"><GlassButton size="s" disabled>중단</GlassButton><GlassButton size="s" disabled>문맥 정리</GlassButton><GlassButton size="s" disabled>재우기</GlassButton><GlassButton size="s" disabled>새 세션</GlassButton></div></section>
   {member?.deliveryWait&&<section className="member-section"><h3>전달 대기</h3><p>{({working:'진행 중인 실행이 끝나기를 기다립니다.',sequence:'앞선 입력의 처리를 기다립니다.',session:'실행 세션의 확인을 기다립니다.'} as Record<string,string>)[member.deliveryWait.kind]??member.deliveryWait.kind}</p><GlassButton size="s" disabled>재확인</GlassButton></section>}
   {Boolean(member?.openAsks)&&<section className="member-section"><h3>결재 대기 {member!.openAsks}건</h3><GlassButton size="s" disabled>결재 확인</GlassButton></section>}
   <section className="member-section"><h3>실행 설정</h3><dl className="settings-list"><dt>CLI</dt><dd>{member?.cli??'—'}</dd><dt>모델</dt><dd>{member?.modelOverride??'직급 기본값'}</dd><dt>추론 수준</dt><dd>{member?.effort??'미수집'}</dd></dl><GlassButton size="s" disabled>변경</GlassButton></section>
   <section className="member-section"><h3>터미널</h3><div className="runtime-actions"><GlassButton size="s" disabled>화면 열기</GlassButton><GlassButton size="s" disabled>명령 복사</GlassButton></div></section>
  </div>}
  {pane.kind==='relations'&&<div className="inspector-list relation-list">{pane.edges.map(e=>{const a=byNode.get(e.from)!,b=byNode.get(e.to)!;return <article key={e.id}><button className="relation-member" onClick={()=>a.memberId&&onMember(a.memberId)}>{a.memberId?memberName(a.memberId):'미배정'}</button><button onClick={()=>onTask(a.taskId)}>{title(a.taskId)}</button><span aria-label="다음 업무">↓</span><button onClick={()=>onTask(b.taskId)}>{title(b.taskId)}</button><GlassButton size="s" variant="ghost" onClick={()=>onFocus(a.taskId)}>연결 보기</GlassButton></article>})}</div>}
  {pane.kind==='members'&&<div className="inspector-list member-directory">{pane.ids.map(id=><button key={id} onClick={()=>onMember(id)}><b>{memberName(id)}</b><span>{data.members.find(m=>m.id===id)?.role}</span><i aria-hidden="true">→</i></button>)}</div>}
  {pane.kind==='team'&&<div className="inspector-list"><section className="member-section">{pane.section==='report'?<p>{data.project.now||'등록된 팀 상황이 없습니다.'}</p>:pane.section==='memory'?<p>개발 기억은 프로젝트 전체에서 관리합니다.</p>:pane.section==='legacy'?<><p>업무 흐름에 포함되지 않은 기록 {data.tasks.filter(t=>!nodes.some(n=>n.taskId===t.id)).length}개</p><p className="muted-note">원래 진행판 본문과 제외 이유는 이 예시에 수집하지 않았습니다.</p>{data.tasks.filter(t=>!nodes.some(n=>n.taskId===t.id)).map(t=><article className="outside-record" key={t.id}><strong>{t.title}</strong><time>{stamp(t.updatedAt??t.createdAt)}</time>{t.parentTaskId&&<p>부모: {title(t.parentTaskId)}</p>}</article>)}</>:<div className="create-member-fields"><label>이름<input disabled placeholder="직원 이름"/></label><label>역할<textarea disabled placeholder="담당할 일"/></label><GlassButton size="s" disabled>{data.project.runnerEnabled?'직원 추가':'총괄 시작'}</GlassButton></div>}</section>{pane.section==='memory'&&<GlassButton size="s" disabled>개발 기억 열기</GlassButton>}</div>}
  {pane.kind==='member'&&<footer className="member-input"><textarea aria-label={`${memberName(pane.memberId)}에게 지시나 질문`} placeholder="지시나 질문" disabled/><GlassButton size="s" disabled ariaLabel="직원에게 보내기">↑</GlassButton></footer>}
 </>
}
