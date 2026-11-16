
import{test,expect,afterAll,afterEach}from'bun:test';
import{mkdtempSync,writeFileSync}from'node:fs';import{join}from'node:path';
import{Bus}from'../server/bus.ts';import{openDb}from'../server/db.ts';import{Store,ApiError}from'../server/store.ts';
import{AgentAClient,AgentAService}from'../server/integrations/agent-a.ts';import{AgentAReview}from'../server/integrations/agent-a-review.ts';import{fakeAgentAReview}from'./fixtures/fake-agent-a-review.ts';
const records:any[]=[],closing:any[]=[];afterEach(()=>{for(const c of closing.splice(0))c();});afterAll(()=>writeFileSync(join(process.env.REVIEW_STAGE!,'independent-fake-results.json'),JSON.stringify(records,null,2)));
const status=async(p:Promise<any>)=>p.then(v=>({status:200,value:v}),e=>({status:e.status||0,message:e.message,code:e.code}));
async function fresh(){
 const fake=fakeAgentAReview({answerDelayMs:1});fake.setEnabled(false);
 const store=new Store(openDb(join(mkdtempSync(join(process.env.REVIEW_STAGE!,'home/own-')),'isolated.db')),new Bus());
 const project=store.createProject({name:'격리 검토',cwd:process.env.REVIEW_STAGE!});
 const hooks:{run?:any}={};const calls:any[]=[];
 const transport=async(input:any,init:any)=>{const r=await fake.transport(input,init);if(hooks.run)await hooks.run(input,init,r);calls.push({url:String(input),method:init?.method,status:r.status});return r;};
 const client=new AgentAClient({baseUrl:'http://127.0.0.1:4999',appToken:null,agentToken:null},transport);
 const service=new AgentAService(store,client),review=new AgentAReview(service);
 const doc=await service.createDoc(project.id,{title:'격리 문서',markdown:'## 계획\n\n원래 본문'});
 const opened=await review.open(doc.fileId);closing.push(()=>{fake.stop();store.db.close()});
 return{fake,store,project,service,review,client,doc,opened,hooks,calls};
}
for(const advance of [false,true])test('동시 편집 보존: 외부 저장이 세대를 '+(advance?'증가시킬 때':'유지할 때'),async()=>{
 const s=await fresh(),session=s.fake.sessions[0]!;
 session.draft={annotations:[{id:'old',type:'COMMENT',text:'옛 댓글',originalText:'',createdA:1}],globalAttachments:[],editedMarkdown:'옛 초안'};session.draft_generation=7;
 let once=false;s.hooks.run=(url:any,init:any,r:Response)=>{if(!once&&new URL(String(url)).pathname==='/api/draft'&&init.method==='GET'){once=true;session.draft={...session.draft,editedMarkdown:'다른 화면의 새 편집',globalAttachments:[{name:'new.png',path:'/assets/new'}],annotations:[...session.draft.annotations,{id:'concurrent',type:'COMMENT',text:'동시 댓글',originalText:'',createdA:1}]};if(advance)session.draft_generation++;}};
 const result=await s.review.addComment(s.doc.fileId,s.opened.sessionId,{id:'ours',kind:'global',text:'새 댓글'});
 records.push({case:'draft-race',advance,result,draft:structuredClone(session.draft),generation:session.draft_generation,calls:s.calls});
 expect(result.ok).toBe(true);expect(session.draft.editedMarkdown).toBe('다른 화면의 새 편집');expect(session.draft.annotations.map((a:any)=>a.id)).toContain('concurrent');expect(session.draft.globalAttachments).toHaveLength(1);expect(session.draft.annotations.map((a:any)=>a.id)).toContain('ours');
});
test('직접 고치기 동일 요청 재전송은 최초 성공을 확인해야 한다',async()=>{
 const s=await fresh(),state=await s.review.manage(s.doc.fileId),b=state.blocks.find(b=>b.title==='계획')!;
 const input={blockId:b.id,revision:b.revision,title:b.title,body:'한 번 저장한 글',opId:'same-edit-request'};
 const first=await status(s.review.edit(s.doc.fileId,input)),again=await status(s.review.edit(s.doc.fileId,input));const now=await s.review.manage(s.doc.fileId);
 records.push({case:'edit-replay',first,again,block:now.blocks.find(x=>x.id===b.id),calls:s.calls});expect(first.status).toBe(200);expect(again.status).toBe(200);expect(now.blocks.find(x=>x.id===b.id)!.revision).toBe(b.revision+1);
});
test('되살리기 동일 요청 재전송도 최초 결과를 확인해야 한다',async()=>{
 const s=await fresh(),m=await s.review.manage(s.doc.fileId),b=m.blocks.find(b=>b.title==='계획')!;
 await s.review.edit(s.doc.fileId,{blockId:b.id,revision:b.revision,title:b.title,body:'고친 글',opId:'prepare-history'});
 const input={blockId:b.id,revision:b.revision+1,historyRevision:b.revision,opId:'same-restore-request'};
 const first=await status(s.review.restore(s.doc.fileId,input)),again=await status(s.review.restore(s.doc.fileId,input));records.push({case:'restore-replay',first,again,calls:s.calls});expect(first.status).toBe(200);expect(again.status).toBe(200);
});
test('정상 댓글·다른 문서/검토·임의 경로는 분리한다',async()=>{
 const s=await fresh(),d=await s.service.createDoc(s.project.id,{title:'다른 문서',markdown:'다른 본문'}),other=await s.review.open(d.fileId);
 const bad=await status(s.review.comments(d.fileId,s.opened.sessionId,null));expect(bad.status).toBe(409);
 expect((await status(s.review.addComment(s.doc.fileId,s.opened.sessionId,{id:'control',kind:'global',text:'정상'}))).status).toBe(200);
 expect((await status(s.review.comments(s.doc.fileId,other.sessionId,null))).status).toBe(409);
 expect((await status(s.review.image(s.doc.fileId,s.opened.sessionId,'/api/config'))).status).toBe(404);
 await expect(s.client.reviewCall('GET','/api/../config',{artifactId:s.doc.artifactId})).rejects.toThrow();
 records.push({case:'scope-control',bad});
});
