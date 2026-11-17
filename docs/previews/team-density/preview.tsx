import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Glass, GlassButton, GlassDefs, AuroraField } from '../../../web/src/glass';
import { workflowBucket, workflowCategory, workflowSummary, workflowTaskCategories, type WorkflowFilter } from '../../../shared/workflow-view';
import type { WorkflowNode } from '../../../shared/workflow';
import MapExplorer from './MapExplorer';
import { Inspector, type Snapshot, type Pane, type Tab } from './Inspector';
const data:Snapshot=(window as any).PREVIEW_DATA;
const tasks=new Map(data.tasks.map(t=>[t.id,t]));
const summary=workflowSummary(data.workflow.nodes),categories=workflowTaskCategories(data.workflow.nodes);
const filters:[WorkflowFilter,string][]=[['all','전체'],['action','확인 필요'],['running','실행 중'],['next','다음'],['done','완료'],['unassigned','미배정']];
const title=(n:WorkflowNode)=>tasks.get(n.taskId)?.title??'업무';
const running=(n:WorkflowNode)=>['running','starting'].includes(n.state);
const blocked=(n:WorkflowNode)=>['blocked','unknown'].includes(n.state);
const checking=(n:WorkflowNode)=>workflowCategory(n)==='action';
const time=(n:WorkflowNode)=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(tasks.get(n.taskId)?.progress?.since??n.assignedAt));
const ordered=(ns:WorkflowNode[])=>[...ns].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
const recent=(ns:WorkflowNode[])=>[...ns].sort((a,b)=>(Date.parse(tasks.get(b.taskId)?.progress?.since??b.assignedAt)||0)-(Date.parse(tasks.get(a.taskId)?.progress?.since??a.assignedAt)||0));
const representative=(ns:WorkflowNode[])=>[...ns].sort((a,b)=>(running(a)?0:blocked(a)?1:2)-(running(b)?0:blocked(b)?1:2)||a.order-b.order)[0];
const memberName=(id:string)=>data.members.find(m=>m.id===id)?.name??'이전 직원';
function App(){
 const [mode,setMode]=useState<'compact'|'map'>(location.hash==='#map'?'map':'compact'),[filter,setFilter]=useState<WorkflowFilter>('all'),[query,setQuery]=useState('');
 const [pane,setPane]=useState<Pane|null>(null),[history,setHistory]=useState<Pane[]>([]),[focusTask,setFocusTask]=useState<string|null>(null),[returnPane,setReturnPane]=useState<Pane|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),origin=useRef<HTMLElement|null>(null),work=useRef<HTMLElement>(null),focusOrigin=useRef<{mode:'compact'|'map';scroll:number}>({mode:'map',scroll:0});
 const matches=(n:WorkflowNode)=>(filter==='all'||categories.get(n.taskId)===filter)&&(!query||`${title(n)} ${n.memberId?memberName(n.memberId):'미배정'}`.toLowerCase().includes(query.toLowerCase()));
 const visible=new Set(data.workflow.nodes.filter(matches).map(n=>n.taskId));
 const members=[...data.members,...[...new Set(data.workflow.nodes.map(n=>n.memberId).filter(Boolean))].filter(id=>!data.members.some(m=>m.id===id)).map(id=>({id:id!,name:'이전 직원',kind:'worker',status:'offline'} as any))];
 const rows=members.map(m=>({m,all:ordered(data.workflow.nodes.filter(n=>n.memberId===m.id)),nodes:ordered(data.workflow.nodes.filter(n=>n.memberId===m.id&&matches(n)))})).filter(r=>r.nodes.length||(filter==='all'&&!query));
 const show=(p:Pane)=>{if(pane)setHistory(h=>[...h,pane]);else{origin.current=document.activeElement as HTMLElement;setHistory([])}setPane(p)};
 const openMember=(id:string)=>show({kind:'member',memberId:id,section:'summary',tab:'all',expanded:null});
 const openTasks=(memberId:string,tab:Tab='all',expanded:string|null=null)=>show({kind:'member',memberId,section:'tasks',tab,expanded});
 const openList=(ids:string[],name:string)=>show({kind:'tasks',ids,title:name,expanded:null});
 const openNode=(n:WorkflowNode,tab:Tab='all')=>n.memberId?openTasks(n.memberId,tab,n.id):show({kind:'tasks',title:'미배정 업무',ids:[...new Set(data.workflow.nodes.filter(n=>!n.memberId&&n.state!=='done').map(n=>n.taskId))],expanded:n.id});
 const openTask=(id:string)=>{const ns=data.workflow.nodes.filter(n=>n.taskId===id);if(ns.length)openNode(ns.find(blocked)??representative(ns))};
 const close=()=>setPane(null);
 const concentrate=(id:string)=>{focusOrigin.current={mode,scroll:work.current?.scrollTop??0};setReturnPane(pane);setFocusTask(id);setMode('map');close();work.current?.scrollTo(0,0)};
 useEffect(()=>{if(pane){if(!dialog.current?.open)dialog.current?.showModal()}else if(dialog.current?.open){dialog.current.close();origin.current?.focus({preventScroll:true})}},[!!pane]);
 const expanded=pane&&(pane.kind==='member'||pane.kind==='tasks')?pane.expanded:null;
 useEffect(()=>{if(expanded)requestAnimationFrame(()=>dialog.current?.querySelector('.detail-item[data-expanded]')?.scrollIntoView({block:'nearest'}))},[expanded,!!pane]);
 const nodeButton=(n:WorkflowNode,tab:Tab='all',extra=0)=><button className="summary-task" data-node-id={n.id} onClick={()=>openNode(n,tab)} onContextMenu={e=>{e.preventDefault();concentrate(n.taskId)}} onKeyDown={e=>{if(e.shiftKey&&e.key==='F10'){e.preventDefault();concentrate(n.taskId)}}} title={title(n)}><span className="task-meta" data-state={n.state}>{n.label}{extra>0&&<b>{tab==='next'?'다른 대기 ':'외 '}{extra}</b>}</span><span className="task-title">{title(n)}</span></button>;
 const paneTitle=pane?.kind==='member'?memberName(pane.memberId):pane?.kind==='tasks'||pane?.kind==='members'?pane.title:pane?.kind==='relations'?'직원별 선후관계':pane?.kind==='team'?({report:'팀 상황',memory:'개발 기억',legacy:'진행판 기록',create:'직원 추가'}[pane.section]):'상세';
 const paneSub=pane?.kind==='member'?({working:'실행 중',idle:'대기',blocked:'승인·입력 확인',error:'오류',asleep:'잠듦',offline:'오프라인'} as Record<string,string>)[data.members.find(m=>m.id===pane.memberId)?.status??'']:pane?.kind==='tasks'?`업무 ${pane.ids.length}개`:pane?.kind==='relations'?`${pane.edges.length}개 관계`:pane?.kind==='members'?`참여 직원 ${pane.ids.length}명`:null;
 return <><GlassDefs/><AuroraField/>
  <Glass as="aside" className="preview-rail" tint><div className="brand"><i/>IAMCEO</div><div className="rail-home">본사</div><small>프로젝트</small>{['네이티브 · Codex 체험','디자인 개편',data.project.name,'Novel of the world'].map(n=><div key={n} className="rail-item" data-selected={n===data.project.name||undefined}>{n}</div>)}<div className="rail-foot">설정</div></Glass>
  <header className="app-top"><b>{data.project.name}</b><Glass as="nav" radius={999} className="app-tabs">{['홈','결재함','팀','대화','자료'].map(n=><span key={n} data-active={n==='팀'||undefined}>{n}</span>)}</Glass></header>
  <main className="workspace" ref={work}>
   <Glass as="section" tint className="overview" aria-label="팀 업무 요약">
    <header className="overview-head"><h1>업무 흐름 <small>직원 {data.members.length}</small></h1><div className="view-modes"><GlassButton size="s" variant="ghost" ariaPressed={mode==='compact'} onClick={()=>{setMode('compact');setFocusTask(null)}}>한눈에</GlassButton><GlassButton size="s" variant="ghost" ariaPressed={mode==='map'} onClick={()=>setMode('map')}>전체 지도</GlassButton><details className="team-menu"><summary aria-label="팀 메뉴">⋯</summary><div>{([['report','팀 상황'],['memory','개발 기억'],['legacy','진행판 기록'],['create','직원 추가']] as const).map(([key,label])=><button key={key} onClick={e=>{e.currentTarget.closest('details')?.removeAttribute('open');show({kind:'team',section:key})}}>{label}</button>)}</div></details></div></header>
    <div className="toolbar"><div className="filter-list">{filters.map(([key,label])=><GlassButton key={key} variant="ghost" size="s" ariaPressed={!focusTask&&filter===key} onClick={()=>{setFocusTask(null);if(key==='unassigned'){openList([...new Set(data.workflow.nodes.filter(n=>!n.memberId&&n.state!=='done').map(n=>n.taskId))],'미배정 업무')}else setFilter(key)}}>{label}<span className="count">{summary[key]}</span></GlassButton>)}</div><label className="search"><span aria-hidden="true">⌕</span><input aria-label="직원·업무 검색" placeholder="직원·업무 검색" value={query} onChange={e=>{setQuery(e.target.value);setFocusTask(null)}}/>{query&&<button onClick={()=>setQuery('')} aria-label="검색 지우기">×</button>}</label></div>
    {mode==='compact'?<>
     <div className="table-header"><span>직원</span><span>지금</span><span>다음·대기</span><span>확인 필요</span><span>최근 완료</span></div>
     <div className="summary-table">{rows.map(({m,all,nodes})=>{
      const now=nodes.filter(n=>workflowBucket(n)==='now'),next=nodes.filter(n=>workflowBucket(n)==='next'),done=recent(nodes.filter(n=>n.state==='done')),checks=nodes.filter(checking),blocks=checks.filter(blocked),reviews=checks.filter(n=>!blocked(n)),head=representative(now);
      return <article className="person-row" key={m.id} data-member-id={m.id}>
       <button className="person" onClick={()=>openMember(m.id)} title={m.name}><span className="person-name"><i data-status={m.status}/><b>{m.name===data.project.name+' 총괄'?'총괄':m.name}</b></span><small>업무 {all.length}</small></button>
       <div className="now-cell">{head?nodeButton(head,'now',now.filter(n=>n.label===head.label).length-1):<span className="empty">현재 실행 없음</span>}</div>
       <div className="next-cell">{next[0]?nodeButton(next[0],'next',next.length-1):<span className="empty">—</span>}</div>
       <div className="check-cell">{blocks.length?<button className="blocked-count" onClick={()=>openTasks(m.id,'blocked')}>막힘 <b>{blocks.length}</b></button>:null}{reviews.length?<button onClick={()=>openTasks(m.id,'checks')}>{reviews.every(n=>n.state==='review')?'검토':'확인'} <b>{reviews.length}</b></button>:null}{!checks.length?<span className="empty">—</span>:null}</div>
       <div className="done-cell">{done[0]?<button className="summary-task" onClick={()=>openTasks(m.id,'done',done[0].id)} title={title(done[0])}><span className="task-meta">{time(done[0])}{done.length>1&&<b>+{done.length-1}</b>}</span><span className="task-title">{title(done[0])}</span></button>:<span className="empty">—</span>}</div>
       <div className="mobile-counts"><button onClick={()=>openTasks(m.id,'next')}>다음·대기 {next.length}</button><button data-warn={blocks.length>0||undefined} onClick={()=>openTasks(m.id,'checks')}>확인 필요 {checks.length}</button><button onClick={()=>openTasks(m.id,'done')}>완료 {done.length}</button></div>
      </article>
     })}</div>
     {!rows.length&&<p className="empty-result">해당하는 직원·업무가 없습니다.</p>}
    </>:<>{focusTask&&<div className="return-detail"><GlassButton size="s" variant="ghost" onClick={()=>{setFocusTask(null);setMode(focusOrigin.current.mode);requestAnimationFrame(()=>work.current?.scrollTo(0,focusOrigin.current.scroll))}}>← 이전 보기</GlassButton>{returnPane&&<GlassButton size="s" variant="ghost" onClick={()=>{setPane(returnPane);setReturnPane(null)}}>상세로 돌아가기</GlassButton>}</div>}<MapExplorer data={data} visible={visible} focusTask={focusTask} onFocus={id=>{if(id&&!focusTask)focusOrigin.current={mode:'map',scroll:work.current?.scrollTop??0};setFocusTask(id)}} onMember={openMember} onTask={openTask} onList={openList} onRelations={edges=>show({kind:'relations',edges})} onMembers={(ids,title)=>show({kind:'members',ids,title})} onRecords={()=>show({kind:'team',section:'legacy'})}/></>}
   </Glass>
  </main>
  <Glass className="composer" tint><div><span className="recipient">총괄⌄</span><span className="recipient selected">전체</span></div><div className="composer-input"><span aria-hidden="true">♧</span><span>지시나 질문</span><span className="send" aria-hidden="true">↑</span></div></Glass>
  <dialog ref={dialog} className="inspector" aria-label={paneTitle} onCancel={e=>{e.preventDefault();close()}} onClick={e=>{if(e.target===e.currentTarget)close()}}>
   {pane&&<Glass tint className="inspector-body"><header className="inspector-head">{history.length>0&&<GlassButton variant="ghost" size="s" ariaLabel="이전 상세" onClick={()=>{setPane(history.at(-1)!);setHistory(history.slice(0,-1))}}>←</GlassButton>}<div><h2>{paneTitle}</h2>{paneSub&&<p>{paneSub}</p>}</div><GlassButton variant="ghost" size="m" ariaLabel="닫기" onClick={close}>×</GlassButton></header><Inspector data={data} pane={pane} setPane={setPane} onMember={openMember} onTask={openTask} onFocus={concentrate}/></Glass>}
  </dialog>
 </>
}
createRoot(document.getElementById('root')!).render(<App/>);
