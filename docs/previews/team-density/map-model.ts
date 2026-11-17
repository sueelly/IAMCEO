import type { Task } from '../../../shared/types';
import type { ProjectWorkflow, WorkflowNode } from '../../../shared/workflow';
import { workflowSummary } from '../../../shared/workflow-view';
export function mapModel(tasks:Task[],flow:ProjectWorkflow){
 const taskMap=new Map(tasks.map(t=>[t.id,t])),byNode=new Map(flow.nodes.map(n=>[n.id,n]));
 const occurrences=new Map<string,WorkflowNode[]>();for(const n of flow.nodes)occurrences.set(n.taskId,[...(occurrences.get(n.taskId)??[]),n]);
 const ids=new Set(occurrences.keys()),families=new Map<string,string[]>();
 for(const id of ids){let root=id;const path:string[]=[];while(taskMap.get(root)?.parentTaskId&&ids.has(taskMap.get(root)!.parentTaskId!)){if(path.includes(root)){root=[...path.slice(path.indexOf(root)),root].sort()[0];break}path.push(root);root=taskMap.get(root)!.parentTaskId!}families.set(root,[...(families.get(root)??[]),id])}
 const groups:[string,string[]][]=[...families].filter(([,v])=>v.length>1);const singles=[...families.values()].filter(v=>v.length===1).flat();if(singles.length)groups.push(['individual',singles]);
 const grouped=groups.sort((a,b)=>b[1].length-a[1].length||a[0].localeCompare(b[0])).map(([id,taskIds])=>{
  const nodes=taskIds.flatMap(t=>occurrences.get(t)??[]),members=[...new Set(nodes.map(n=>n.memberId).filter(Boolean))] as string[];
  return {id,title:id==='individual'?'개별 업무':taskMap.get(id)?.title??'연결 확인 필요',taskIds,members,counts:workflowSummary(nodes),blocked:new Set(nodes.filter(n=>['blocked','unknown'].includes(n.state)).map(n=>n.taskId)).size};
 });
 const owner=new Map<string,string>();for(const g of grouped)for(const id of g.taskIds)owner.set(id,g.id);
 const links=new Map<string,{id:string;from:string;to:string;edges:typeof flow.edges}>();
 for(const edge of flow.edges){if(edge.kind!=='sequence')continue;const a=byNode.get(edge.from),b=byNode.get(edge.to);if(!a||!b)continue;const from=owner.get(a.taskId)!,to=owner.get(b.taskId)!;if(from===to)continue;const pair=[from,to].sort(),key=pair.join(':');const link=links.get(key)??{id:key,from:pair[0],to:pair[1],edges:[]};link.edges.push(edge);links.set(key,link)}
 return {groups:grouped,links:[...links.values()],taskMap,byNode,occurrences};
}
