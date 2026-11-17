import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { workflowBucket, workflowCategory, workflowSummary } from '../../../shared/workflow-view';
import type { WorkflowNode } from '../../../shared/workflow';
import { mapModel } from './map-model';
const [snapshotPath,outputPath]=process.argv.slice(2);
if(!snapshotPath||!outputPath) throw new Error('Usage: bun build.ts PRIVATE_SNAPSHOT PRIVATE_OUTPUT_DIRECTORY');
const root=resolve(import.meta.dir,'../../..'),output=resolve(outputPath);
if(output.startsWith(root+'/')) throw new Error('실제 운영 기록은 저장소 밖에 저장합니다');
const snapshot=JSON.parse(await readFile(snapshotPath,'utf8'));
await mkdir(output,{recursive:true,mode:0o700});
const build=await Bun.build({entrypoints:[join(import.meta.dir,'preview.tsx')],target:'browser',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
if(!build.success) throw new AggregateError(build.logs);
const js=await build.outputs.find(p=>p.path.endsWith('.js'))!.text();
const css=(await Promise.all(['web/src/styles/tokens.css','web/src/styles/glass.css','docs/previews/team-density/preview.css'].map(p=>readFile(join(root,p),'utf8')))).join('\n');
const safe=(s:string)=>s.replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
await writeFile(join(output,'index.html'),`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>God of the world · 팀 화면 설계</title><style>${css}</style><body><div id="root"></div><script>window.PREVIEW_DATA=${safe(JSON.stringify(snapshot))}</script><script>${js.replaceAll('</script','<\\/script')}</script></body></html>`,{mode:0o600});
const nodes:WorkflowNode[]=snapshot.workflow.nodes;
const taskMap=new Map<string,any>(snapshot.tasks.map((t:any)=>[t.id,t]));
const counts=workflowSummary(nodes),model=mapModel(snapshot.tasks,snapshot.workflow);
const plain=(s:unknown)=>String(s??'—').replaceAll('|','\\|').replaceAll('\n',' ');
const memberName=(id:string)=>snapshot.members.find((m:any)=>m.id===id)?.name??'이전 직원';
const lines=[
 '# God of the world 팀 화면 예시 · 직원 상세와 전체 지도','',
 '큰 업무의 진행·막힘 → 직원 참여 → 업무 선후관계 순으로 읽는 전체 지도와 기존 직원 상세를 연결한 2차 설계 예시입니다. 한눈에 보기와 전체 지도를 전환하고 같은 상세 팝업에서 업무·활동·실행/설정을 확인합니다.','',
 `실제 구성을 관측한 시점: ${snapshot.capturedAt} (한국 시간 ${new Intl.DateTimeFormat('ko-KR',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(snapshot.capturedAt))}). 운영 소스: ${snapshot.sourceSha}.`,
 '실제 직원 이름·업무 제목·관계를 읽기 전용 스냅샷으로 구성했습니다. 현재 실시간 상태가 아니며 예시를 열거나 조작해도 운영 배정·지시·승인·중단 상태는 바뀌지 않습니다. 운영 화면에는 아직 이 요약 구조를 적용하지 않았습니다.','',
 '## 추천 구조','',
 '- 직원 한 명을 한 행으로 표시하고 지금, 다음·대기, 확인 필요, 최근 완료를 같은 열에서 비교합니다.',
 '- 직원 이름은 통합 상세의 요약을, 업무 제목·막힘·검토 숫자는 같은 상세의 해당 업무 범위를 엽니다. 요약·업무·활동·실행/설정을 전환해도 직원은 바뀌지 않습니다.',
 '- 실행 중 옆의 외 N은 같은 상태의 추가 업무입니다. 검토·막힘을 실행 중 수에 합치지 않습니다.',
 '- 전체 지도에서 부모 업무 묶음 제목은 연결 지도를, 업무 수는 전체 목록을 엽니다. 직원 칩은 상세를, 외 N은 참여 직원 전체를 엽니다.',
 '- 위쪽 미배정 숫자는 전체 미배정 목록을 엽니다. 우클릭이나 상세의 연결만 보기로 실제 직접 연결을 펼칩니다. 이전 보기와 상세로 돌아가기로 탐색 맥락을 복원합니다.',
 '- 묶음 연결은 화살표 없이 관계 수를 표시합니다. 선택하면 실제 직원과 업무 A → B를 읽습니다. 묶음 전체를 선행 조건으로 해석하지 않습니다. 상세의 점선은 부모·파생, 실선은 직원별 순서입니다.',
 '- 휴대폰에서는 작은 지도와 읽을 수 있는 전체 목록을 함께 제공합니다. 상세는 아래에서 올라오는 동일 팝업입니다.',
 '- 원래 직원 설정·터미널·승인·직접 지시는 같은 상세에 유지하는 제안입니다. 제어 버튼과 입력은 비활성입니다. 활동 탭은 업무의 마지막 기록만 재현하며 전체 실시간 로그나 터미널 화면을 수집하지 않았습니다.',
 '- 하단 반복 직원 카드는 요약 행과 동일 상세로 통합합니다. 팀 상황·개발 기억·직원 추가·독립 진행판 기록은 위쪽 팀 메뉴로 이동합니다. 독립 진행판 원문과 기억 내용은 예시에 수집하지 않았고 실제 데이터를 삭제하지 않았습니다.','',
 `상단 고유 업무 집계: 전체 ${counts.all}, 확인 필요 ${counts.action}, 실행 중 ${counts.running}, 다음 ${counts.next}, 완료 ${counts.done}, 미배정 ${counts.unassigned}.`,
 `담당별 표시 ${nodes.length}개와 고유 업무 ${counts.all}개는 다른 수입니다. 같은 업무가 여러 직원에게 보이므로 직원별 합계와 상단 합계는 같지 않습니다. 실행 중 업무 표시 수는 세션 수가 아닙니다.`,`전체 업무 메타데이터 ${snapshot.tasks.length}개 중 업무 흐름에 연결된 ${counts.all}개를 지도에 표시했습니다. 흐름 밖의 기록을 삭제하거나 새 실행으로 등록하지 않았습니다.`, '',
 '## 직원별 전체 구성','','지금과 확인 필요는 일부 겹칩니다. 지금은 화면 위치, 확인 필요는 확인해야 할 상태를 뜻합니다.','',
 '| 직원 | 전체 | 지금 | 다음·대기 | 확인 필요 | 완료 |','| --- | ---: | ---: | ---: | ---: | ---: |'
];
for(const member of snapshot.members){
 const ns=nodes.filter(n=>n.memberId===member.id);
 lines.push(`| ${plain(member.name)} | ${ns.length} | ${ns.filter(n=>workflowBucket(n)==='now').length} | ${ns.filter(n=>workflowBucket(n)==='next').length} | ${ns.filter(n=>workflowCategory(n)==='action').length} | ${ns.filter(n=>n.state==='done').length} |`);
}
lines.push('','## 전체 지도','','| 업무 묶음 | 전체 | 막힘 | 확인 필요 | 실행 중 | 다음 | 완료 | 미배정 | 참여 직원 |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for(const group of model.groups) lines.push(`| ${plain(group.title)} | ${group.taskIds.length} | ${group.blocked} | ${group.counts.action} | ${group.counts.running} | ${group.counts.next} | ${group.counts.done} | ${group.counts.unassigned} | ${group.members.map(memberName).map(plain).join(' · ')} |`);
lines.push('','막힘은 확인 필요에 포함되는 상태입니다. 확인 필요·실행 중·다음·완료·미배정은 기존 고유 업무 분류에 따른 상호 배타적 합계이며 실행 세션 수가 아닙니다. 개별 업무는 공통 부모가 없는 업무를 모은 화면상의 묶음입니다.','','### 묶음 간 순서 관계','');
for(const link of model.links) lines.push(`- ${plain(model.groups.find(g=>g.id===link.from)?.title)} ↔ ${plain(model.groups.find(g=>g.id===link.to)?.title)}: 원본 직원별 순서 ${link.edges.length}건. 아래 전체 연결에서 원래 방향과 업무를 확인합니다.`);
lines.push('','## 직원 상세의 관측 정보','');
for(const m of snapshot.members){
 lines.push(`### ${plain(m.name)}`,'',`- 관측 상태: ${m.status}; 문맥: ${m.contextPct??'미수집'}%; 입력 대기: ${m.queuedCount??'미수집'}; 결재 대기: ${m.openAsks??'미수집'}.`,`- 역할: ${plain(m.role)}`,`- 최근 보고: ${plain(m.now)}`,`- 다음 보고: ${plain(m.next)}`,`- CLI: ${plain(m.cli)}; 모델: ${plain(m.modelOverride??'직급 기본값')}; 추론 수준: ${plain(m.effort??'미수집 / 실제 설정 확인 필요')}.`);
 if(m.deliveryWait) lines.push(`- 전달 대기: ${plain(m.deliveryWait.kind)}.`);
 if(m.executionIssue) lines.push(`- 실행 문제: ${plain(m.executionIssue.message??m.executionIssue.kind)}.`);
 lines.push('');
}
lines.push('','## 모든 업무와 관계','','아래는 담당별 원래 순서입니다. 같은 업무 ID는 같은 업무이며 부모 ID가 있으면 파생 관계입니다. 확인 필요인 업무를 완료로 바꾸거나 대기열에 새로 등록하지 않습니다.');
const missingMemberIds=[...new Set(nodes.map(n=>n.memberId).filter((id):id is string=>Boolean(id)))].filter(id=>!snapshot.members.some((m:any)=>m.id===id));
for(const member of [...snapshot.members,...missingMemberIds.map(id=>({id,name:'이전 직원 '+id})),{id:null,name:'미배정'}]){
 lines.push('',`### ${member.name}`,'');
 for(const n of nodes.filter(n=>n.memberId===member.id).sort((a,b)=>a.order-b.order)){
  const t=taskMap.get(n.taskId);
  lines.push(`- [${n.taskId}] **${plain(t?.title)}** — ${n.label}; 위치: ${{now:'지금',next:'다음·대기',done:'완료',unassigned:'미배정'}[workflowBucket(n)]}.`);
  if(t?.parentTaskId)lines.push(`  부모: [${t.parentTaskId}] ${plain(taskMap.get(t.parentTaskId)?.title)}.`);
  if(n.reason)lines.push(`  상태 근거: ${plain(n.reason)}`);
  if(n.lastActivity)lines.push(`  마지막 기록·${n.lastActivity.kind} (${n.lastActivity.at}): ${plain(n.lastActivity.title)}`);
 }
}
lines.push('','## 업무 흐름 밖의 기록','','아래는 서버의 업무 흐름 응답에 포함되지 않은 업무 메타데이터입니다. 원래 진행판 본문과 제외 사유는 수집하지 않았으며 이를 완료·미배정·새 실행으로 추정하지 않습니다.','');
for(const task of snapshot.tasks.filter((t:any)=>!model.occurrences.has(t.id)))lines.push(`- 기록 [${task.id}] ${plain(task.title)}; 최근 변경: ${task.updatedAt??task.createdAt}; 부모: ${task.parentTaskId??'없음'}.`);
lines.push('','## 전체 원본 연결','','같은 두 업무 사이에도 직원이나 연결 종류가 다르면 별도 근거입니다. 아래에는 화면에서 접힌 연결도 모두 포함합니다.','');
for(const edge of snapshot.workflow.edges){
 const a=model.byNode.get(edge.from),b=model.byNode.get(edge.to);
 if(!a||!b){lines.push(`- ${edge.id}: 연결 대상 확인 필요.`);continue}
 lines.push(`- ${edge.kind==='derived'?'부모·파생':'직원별 순서'} · ${a.memberId?plain(memberName(a.memberId)):'미배정'}: [${a.taskId}] ${plain(taskMap.get(a.taskId)?.title)} → [${b.taskId}] ${plain(taskMap.get(b.taskId)?.title)}. 원본 연결: ${edge.id}`);
}
lines.push('','## 파일 열기','','```sh',`open '${join(output,'index.html')}'`,`cat '${join(output,'README.md')}'`,'```','','HTML은 스타일·스크립트·필요 데이터를 모두 포함합니다. 외부 네트워크 없이 열립니다. 원본 기록과 이 결과물은 Git 밖의 작업 전용 경로에 보관합니다.','');
await writeFile(join(output,'README.md'),lines.join('\n'),{mode:0o600});
console.log(JSON.stringify({html:join(output,'index.html'),capturedAt:snapshot.capturedAt,members:snapshot.members.length,nodes:nodes.length,tasks:counts.all,groups:model.groups.length,edges:snapshot.workflow.edges.length}));
