import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Glass, GlassButton, GlassDefs, AuroraField } from "../../../web/src/glass";
import { workflowBucket, workflowCategory, workflowFocus, workflowSummary, workflowTaskCategories, type WorkflowFilter } from "../../../shared/workflow-view";
import type { WorkflowNode, ProjectWorkflow } from "../../../shared/workflow";
import type { Member, Task } from "../../../shared/types";

type Snapshot = { capturedAt:string; project:{id:string;name:string}; members:Pick<Member,"id"|"name"|"kind"|"status">[];tasks:Task[];workflow:ProjectWorkflow };
const data:Snapshot=(window as any).PREVIEW_DATA;
const tasks=new Map(data.tasks.map(t=>[t.id,t]));
const summary=workflowSummary(data.workflow.nodes),categories=workflowTaskCategories(data.workflow.nodes);
const filters:[WorkflowFilter,string][]=[["all","전체"],["action","확인 필요"],["running","실행 중"],["next","다음"],["done","완료"],["unassigned","미배정"]];
const title=(n:WorkflowNode)=>tasks.get(n.taskId)?.title??"업무";
const running=(n:WorkflowNode)=>["running","starting"].includes(n.state);
const blocked=(n:WorkflowNode)=>["blocked","unknown"].includes(n.state);
const checking=(n:WorkflowNode)=>workflowCategory(n)==="action";
const time=(n:WorkflowNode)=>new Intl.DateTimeFormat("ko-KR",{timeZone:"Asia/Seoul",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(tasks.get(n.taskId)?.progress?.since??n.assignedAt));
const ordered=(ns:WorkflowNode[])=>[...ns].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
const recent=(ns:WorkflowNode[])=>[...ns].sort((a,b)=>(Date.parse(tasks.get(b.taskId)?.progress?.since??b.assignedAt)||0)-(Date.parse(tasks.get(a.taskId)?.progress?.since??a.assignedAt)||0));
const representative=(ns:WorkflowNode[])=>[...ns].sort((a,b)=>(running(a)?0:blocked(a)?1:2)-(running(b)?0:blocked(b)?1:2)||a.order-b.order)[0];
const memberName=(id:string)=>data.members.find(m=>m.id===id)?.name??"이전 직원";
type Tab="all"|"now"|"next"|"checks"|"blocked"|"done";
type Pane={memberId:string;tab:Tab;expanded:string|null};
const tabNames:[Tab,string][]=[["all","전체"],["now","지금"],["next","다음·대기"],["checks","확인 필요"],["done","완료"]];
function selectTab(ns:WorkflowNode[],tab:Tab){return tab==="all"?ns:tab==="checks"?ns.filter(checking):tab==="blocked"?ns.filter(blocked):ns.filter(n=>workflowBucket(n)===tab)}

function App(){
 const [mode,setMode]=useState<"compact"|"cards">("compact"),[filter,setFilter]=useState<WorkflowFilter>("all"),[query,setQuery]=useState("");
 const [pane,setPane]=useState<Pane|null>(null),[focus,setFocus]=useState<{id:string;depth:"direct"|"family"}|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),origin=useRef<HTMLElement|null>(null),work=useRef<HTMLElement>(null),beforeFocus=useRef(0);
 const focused=focus?workflowFocus(data.workflow,focus.id,focus.depth):null;
 const matches=(n:WorkflowNode)=>focused?focused.has(n.id):(filter==="all"||categories.get(n.taskId)===filter)&&(!query||`${title(n)} ${n.memberId?memberName(n.memberId):"미배정"}`.toLowerCase().includes(query.toLowerCase()));
 const members=[...data.members,...[...new Set(data.workflow.nodes.map(n=>n.memberId).filter(Boolean))].filter(id=>!data.members.some(m=>m.id===id)).map(id=>({id:id!,name:"이전 직원",kind:"worker",status:"offline"} as any))];
 const rows=members.map(m=>({m,all:ordered(data.workflow.nodes.filter(n=>n.memberId===m.id)),nodes:ordered(data.workflow.nodes.filter(n=>n.memberId===m.id&&matches(n)))})).filter(r=>r.nodes.length||(!focus&&filter==="all"&&!query));
 const unassigned=data.workflow.nodes.filter(n=>!n.memberId&&n.state!=="done");
 const paneAll=pane?ordered(data.workflow.nodes.filter(n=>pane.memberId==="unassigned"?!n.memberId&&n.state!=="done":n.memberId===pane.memberId)):[];
 const paneNodes=pane?selectTab(paneAll,pane.tab):[];
 const open=(memberId:string,tab:Tab="all",expanded:string|null=null)=>{origin.current=document.activeElement as HTMLElement;setPane({memberId,tab,expanded})};
 const close=()=>setPane(null);
 useEffect(()=>{if(pane){if(!dialog.current?.open)dialog.current?.showModal()}else if(dialog.current?.open){dialog.current.close();origin.current?.focus({preventScroll:true})}},[!!pane]);
 useEffect(()=>{if(pane?.expanded)requestAnimationFrame(()=>dialog.current?.querySelector(".detail-item[data-expanded]")?.scrollIntoView({block:"nearest"}))},[pane?.expanded,!!pane]);
 const concentrate=(n:WorkflowNode)=>{if(!focus)beforeFocus.current=work.current?.scrollTop??0;setFocus({id:n.id,depth:"direct"});close();work.current?.scrollTo(0,0)};
 const restore=()=>{setFocus(null);requestAnimationFrame(()=>work.current?.scrollTo(0,beforeFocus.current))};
 const nodeButton=(n:WorkflowNode,tab:Tab="all",extra=0)=><button className="summary-task" data-node-id={n.id} onClick={()=>open(n.memberId??"unassigned",tab,n.id)} onContextMenu={e=>{e.preventDefault();concentrate(n)}} onKeyDown={e=>{if(e.shiftKey&&e.key==="F10"){e.preventDefault();concentrate(n)}}} title={title(n)}><span className="task-meta" data-state={n.state}>{n.label}{extra>0&&<b>{tab==="next"?"다른 대기 ":"외 "}{extra}</b>}</span><span className="task-title">{title(n)}</span></button>;
 const card=(n:WorkflowNode)=><button className="task-card" data-node-id={n.id} data-state={n.state} key={n.id} onClick={()=>open(n.memberId??"unassigned","all",n.id)} onContextMenu={e=>{e.preventDefault();concentrate(n)}}><span className="task-meta" data-state={n.state}>{n.label}</span><strong>{title(n)}</strong><p>{n.reason??n.lastActivity?.title??""}</p></button>;
 return <><GlassDefs/><AuroraField/>
  <Glass as="aside" className="preview-rail" tint><div className="brand"><i/>IAMCEO</div><div className="rail-home">본사</div><small>프로젝트</small>{["네이티브 · Codex 체험","디자인 개편",data.project.name,"Novel of the world"].map(n=><div key={n} className="rail-item" data-selected={n===data.project.name||undefined}>{n}</div>)}<div className="rail-foot">설정</div></Glass>
  <header className="app-top"><b>{data.project.name}</b><Glass as="nav" radius={999} className="app-tabs">{["홈","결재함","팀","대화","자료"].map(n=><span key={n} data-active={n==="팀"||undefined}>{n}</span>)}</Glass></header>
  <main className="workspace" ref={work}>
   <Glass as="section" tint className="overview" aria-label="팀 업무 요약">
    <header className="overview-head"><div><h1>업무 흐름 <small>직원 {data.members.length}</small></h1></div><div className="view-modes"><GlassButton size="s" variant="ghost" ariaPressed={mode==="compact"} onClick={()=>{setMode("compact");setFocus(null)}}>한눈에</GlassButton><GlassButton size="s" variant="ghost" ariaPressed={mode==="cards"} onClick={()=>{setMode("cards");setFocus(null)}}>전체 카드</GlassButton></div></header>
    <div className="toolbar"><div className="filter-list">{filters.map(([key,label])=><GlassButton key={key} variant="ghost" size="s" ariaPressed={!focus&&filter===key} onClick={()=>{if(key==="unassigned")open("unassigned");else{setFilter(key);setFocus(null)}}}>{label}<span className="count">{summary[key]}</span></GlassButton>)}</div><label className="search"><span aria-hidden="true">⌕</span><input aria-label="직원·업무 검색" placeholder="직원·업무 검색" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button onClick={()=>setQuery("")} aria-label="검색 지우기">×</button>}</label></div>
    {focus?<div className="focus-bar"><strong>{title(data.workflow.nodes.find(n=>n.id===focus.id)!)}</strong><div><GlassButton size="s" variant="ghost" ariaPressed={focus.depth==="family"} onClick={()=>setFocus({...focus,depth:focus.depth==="direct"?"family":"direct"})}>파생 업무 전체</GlassButton><GlassButton size="s" onClick={restore}>전체 보기</GlassButton></div></div>:null}
    {mode==="compact"&&!focus?<>
     <div className="table-header"><span>직원</span><span>지금</span><span>다음·대기</span><span>확인 필요</span><span>최근 완료</span></div>
     <div className="summary-table">{rows.map(({m,all,nodes})=>{
      const now=nodes.filter(n=>workflowBucket(n)==="now"),next=nodes.filter(n=>workflowBucket(n)==="next"),done=recent(nodes.filter(n=>n.state==="done")),checks=nodes.filter(checking),blocks=checks.filter(blocked),reviews=checks.filter(n=>!blocked(n)),head=representative(now);
      return <article className="person-row" key={m.id} data-member-id={m.id}>
       <button className="person" onClick={()=>open(m.id)} title={m.name}><span className="person-name"><i data-status={m.status}/><b>{m.name===data.project.name+" 총괄"?"총괄":m.name}</b></span><small>업무 {all.length}</small></button>
       <div className="now-cell">{head?nodeButton(head,"now",now.filter(n=>n.label===head.label).length-1):<span className="empty">현재 실행 없음</span>}</div>
       <div className="next-cell">{next[0]?nodeButton(next[0],"next",next.length-1):<span className="empty">—</span>}</div>
       <div className="check-cell">{blocks.length?<button className="blocked-count" onClick={()=>open(m.id,"blocked")}>막힘 <b>{blocks.length}</b></button>:null}{reviews.length?<button onClick={()=>open(m.id,"checks")}>{reviews.every(n=>n.state==="review")?"검토":"확인"} <b>{reviews.length}</b></button>:null}{!checks.length?<span className="empty">—</span>:null}</div>
       <div className="done-cell">{done[0]?<button className="summary-task" onClick={()=>open(m.id,"done",done[0].id)} title={title(done[0])}><span className="task-meta">{time(done[0])}{done.length>1&&<b>+{done.length-1}</b>}</span><span className="task-title">{title(done[0])}</span></button>:<span className="empty">—</span>}</div>
       <div className="mobile-counts"><button onClick={()=>open(m.id,"next")}>다음·대기 {next.length}</button><button data-warn={blocks.length>0||undefined} onClick={()=>open(m.id,"checks")}>확인 필요 {checks.length}</button><button onClick={()=>open(m.id,"done")}>완료 {done.length}</button></div>
      </article>
     })}</div>
     {!rows.length&&filter!=="unassigned"&&<p className="empty-result">해당하는 직원·업무가 없습니다.</p>}
    </>:<div className="expanded-board">{rows.map(({m,nodes})=><section className="expanded-row" key={m.id}><button onClick={()=>open(m.id)}>{m.name}</button>{(["done","now","next"] as const).map(bucket=><div className="expanded-column" key={bucket}><h3>{bucket==="done"?"최근 완료":bucket==="now"?"지금":"다음·대기"}</h3>{(bucket==="done"&&!focus?recent(nodes.filter(n=>workflowBucket(n)===bucket)).slice(0,3):nodes.filter(n=>workflowBucket(n)===bucket)).map(card)}</div>)}</section>)}</div>}
    {(mode==="cards"||focus)&&(!focus||unassigned.some(matches))&&<footer className="unassigned-strip"><button onClick={()=>open("unassigned")}><span>미배정</span><b>{unassigned.length}</b><span aria-hidden="true">→</span></button><div>{unassigned.filter(matches).slice(0,2).map(n=><button key={n.id} title={title(n)} onClick={()=>open("unassigned","all",n.id)}>{title(n)}</button>)}</div></footer>}
   </Glass>
  </main>
  <Glass className="composer" tint><div><span className="recipient">총괄⌄</span><span className="recipient selected">전체</span></div><div className="composer-input"><span aria-hidden="true">♧</span><span>지시나 질문</span><span className="send" aria-hidden="true">↑</span></div></Glass>
  <dialog ref={dialog} className="inspector" aria-label={pane?.memberId==="unassigned"?"미배정 업무":pane?memberName(pane.memberId)+" 업무":"업무 상세"} onCancel={e=>{e.preventDefault();close()}} onClick={e=>{if(e.target===e.currentTarget)close()}}>
   {pane&&<Glass tint className="inspector-body"><header className="inspector-head"><div><h2>{pane.memberId==="unassigned"?"미배정":memberName(pane.memberId)}</h2><p>전체 업무 {paneAll.length}</p></div><GlassButton variant="ghost" size="m" ariaLabel="닫기" onClick={close}>×</GlassButton></header>
    {pane.memberId!=="unassigned"&&<nav className="inspector-tabs">{tabNames.map(([key,label])=><GlassButton size="s" variant="ghost" key={key} ariaPressed={pane.tab===key||(pane.tab==="blocked"&&key==="checks")} onClick={()=>setPane({...pane,tab:key,expanded:null})}>{label}<span className="count">{selectTab(paneAll,key).length}</span></GlassButton>)}</nav>}
    <div className="inspector-list">{pane.tab==="blocked"?<p className="list-heading">막힘 {paneNodes.length}</p>:null}{paneNodes.map(n=><article className="detail-item" key={n.id} data-expanded={pane.expanded===n.id||undefined}><button className="detail-title" onClick={()=>setPane({...pane,expanded:pane.expanded===n.id?null:n.id})} onContextMenu={e=>{e.preventDefault();concentrate(n)}}><span className="task-meta" data-state={n.state}>{n.label}</span><strong>{title(n)}</strong><span aria-hidden="true">{pane.expanded===n.id?"−":"+"}</span></button>{pane.expanded===n.id&&<div className="detail-content">{n.reason&&<p className="reason" data-blocked={blocked(n)||undefined}>{n.reason}</p>}{n.lastActivity&&<section><h3>{["text","tool","tool_result","error","turn_start","turn_end","system","compact"].includes(n.lastActivity.kind)?"마지막 실행":"마지막 보고"}</h3><p>{n.lastActivity.title}</p><time>{new Intl.DateTimeFormat("ko-KR",{dateStyle:"short",timeStyle:"short",timeZone:"Asia/Seoul"}).format(new Date(n.lastActivity.at))}</time></section>}{tasks.get(n.taskId)?.parentTaskId&&<section><h3>부모 업무</h3><p>{tasks.get(tasks.get(n.taskId)!.parentTaskId!)?.title??tasks.get(n.taskId)!.parentTaskId}</p></section>}<GlassButton size="s" onClick={()=>concentrate(n)}>연결만 보기</GlassButton></div>}</article>)}{!paneNodes.length&&<p className="empty-result">해당하는 업무가 없습니다.</p>}</div>
   </Glass>}
  </dialog>
 </>
}
createRoot(document.getElementById("root")!).render(<App/>);
