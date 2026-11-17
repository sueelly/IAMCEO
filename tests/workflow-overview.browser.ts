import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { Bus } from "../server/bus.ts";
import { loadConfig, updateConfigFile } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { startServer, type RunningServer } from "../server/http.ts";
import { Store } from "../server/store.ts";
import { Orchestrator } from "../server/orchestrator.ts";
import { FakeRunner } from "./fixtures/harness-fixture.ts";
import { createIsolatedRuntime } from "./fixtures/isolated-runtime.ts";
import type { Member, Project, Task } from "../shared/types.ts";

const CODE="overview-fixture",SHOTS=process.env.IAMCEO_E2E_SHOTS??join(import.meta.dir,"../.superpowers/sdd/2026-11-18-work-overview/screenshots");
let isolated:ReturnType<typeof createIsolatedRuntime>,store:Store,orch:Orchestrator,server:RunningServer,browser:Browser,base:string;
let project:Project,other:Project,lead:Member,worker:Member,reviewer:Member,web:Member,current:Task,next:Task,derived:Task,done:Task,unassigned:Task;
let seq=0;
function makeTask(title:string,parentTaskId?:string){return store.ensureSourceTask({projectId:project.id,sourceRef:`overview-${++seq}`,title,origin:"owner",parentTaskId}).task}
function ready(title:string){const t=makeTask(title);store.createMessage({projectId:project.id,taskId:t.id,mine:true,who:"대표",kind:"나",body:"원문과 완료 조건을 보존해 구현하세요"});store.saveTaskContract(t.id,{kind:"coding",goal:title,acceptance:["브라우저에서 검증한다"],scope:"웹 화면",inputs:["기존 업무 연결"],outputs:["검증한 화면"],constraints:["기존 승인 보존"],exclusions:["자동 승인"],forbidden:["승인 자동 응답 금지"]},{author:"대표",authorMemberId:null,authorKind:"owner"});return t}

beforeAll(async()=>{
  isolated=createIsolatedRuntime();
  const env={IAMCEO_HOME:isolated.paths.iamceoHome,IAMCEO_PORT:"0",IAMCEO_ENABLE_CLI:"false"};
  updateConfigFile({accessCode:CODE,hosts:["127.0.0.1"]},env);const config=loadConfig(env),bus=new Bus();
  store=new Store(openDb(config.dbPath),bus);const runner=new FakeRunner();
  orch=new Orchestrator({config,store,runners:new Map([["core",runner]]),providerHomes:isolated.providerHomes});
  project=store.createProject({name:"업무 관리판",cwd:isolated.paths.work});other=store.createProject({name:"다른 프로젝트",cwd:isolated.paths.work});
  const person=(handle:string,name:string,kind:"worker"|"conductor"="worker")=>{const m=store.createMember({projectId:project.id,handle,name,kind,status:"idle",origin:"runner",backend:"core",cwd:isolated.paths.work,paneId:`pane-${handle}`,sessionId:`session-${handle}`});store.patchMember(m.id,{statusObservation:{source:"core",observedAt:new Date().toISOString(),freshness:"fresh",ownership:"verified",consecutiveFailures:0,error:null}});runner.busy.add(m.id);return m};
  lead=person("lead","총괄","conductor");worker=person("native","네이티브·Codex");reviewer=person("review","하네스 검토");web=person("web","웹 담당");
  store.createMember({projectId:other.id,handle:"other",name:"다른 담당",kind:"worker"});
  done=makeTask("단계 표시 초안");current=makeTask("완료·중단 보호 보완");next=makeTask("오래된 업무 복구");derived=makeTask("보호 보완 재검증",current.id);
  for(const[t,m]of [[done,worker],[current,worker],[next,worker],[derived,reviewer]]as const){const d=store.enqueue({projectId:project.id,taskId:t.id,memberId:m.id,kind:"instruction",text:t.title});if(t!==next)store.markDelivered(d.id)}
  store.addStageMark({projectId:project.id,taskId:done.id,stage:"done",evidence:"초안 검증 완료",memberId:lead.id,who:lead.name});
  await orch.recordPost(worker,{kind:"막힘",title:"중단 뒤 입력 보완 필요",taskId:current.id,checks:[{kind:"behavior",name:"중단",result:"fail",evidence:"입력 잔여"}]});
  store.db.query("DELETE FROM task_sequence WHERE task_id=?").run(current.id);
  const queued = makeTask("검증 근거 정리");store.enqueue({projectId:project.id,taskId:queued.id,memberId:worker.id,kind:"instruction",text:queued.title});
  unassigned=ready("업무 연결 집중 보기");makeTask("자동 반복 실행 후보");
  server=await startServer({config,store,bus,orch});base=server.urls[0]!;browser=await chromium.launch();mkdirSync(SHOTS,{recursive:true});
});
afterAll(async()=>{await browser?.close();await orch?.shutdown();await server?.stop();store?.db.close();await isolated?.stop()});
async function open(width=1440){const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(8000);await page.addInitScript(code=>localStorage.setItem("iamceo.accessCode",code),CODE);await page.goto(`${base}/#/p/${project.id}/team`);await page.locator('.to-row').first().waitFor({timeout:20000});await page.locator('.wf-connection').waitFor({state:"hidden"});return page}
const card=(p:Page,id:string)=>p.locator(`.to-task[data-task-id="${id}"],.to-free[data-task-id="${id}"]`).first();
async function freeTray(p:Page){if(!await p.locator('.to-unassigned').count())await p.getByRole('button',{name:/^미배정/}).click()}
async function assignMenu(p:Page,t:Task){await freeTray(p);await p.getByRole("button",{name:`${t.title} 배정`,exact:true}).click();await p.getByLabel("담당 직원",{exact:true}).selectOption(web.id);await p.getByRole("dialog").getByText("승인 자동 응답 금지",{exact:true}).waitFor()}


test("고정 열과 Glass 구성요소로 현재 업무와 다음 업무를 비교한다",async()=>{
 const p=await open();
 expect(await p.locator('.to-row .to-now').count()).toBeGreaterThanOrEqual(4);
 expect(await p.locator(`.to-row[data-member-id="${worker.id}"] .to-now .to-task[data-task-id="${current.id}"]`).count()).toBe(1);
 expect(await p.locator('.glass.wf .gbtn').count()).toBeGreaterThan(0);
 expect(await p.locator(`[data-member-id="${worker.id}"] .to-done time`).getAttribute('datetime')).toBe(store.taskProgress(done.id).since);
 const lefts=await p.locator('.to-row .to-now').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().left));expect(Math.max(...lefts)-Math.min(...lefts)).toBeLessThan(1);
 expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await p.locator('.wf').screenshot({path:join(SHOTS,"product-overview.png")});await p.close();
},30000);

test("우클릭과 메뉴로 연결된 업무를 집중하고 전체 보기로 복원한다",async()=>{
 const p=await open();const before=await p.locator('.to-row').count();
 await card(p,current.id).click({button:"right"});await p.locator('.map-task[data-center]').waitFor();
 expect(await p.locator(`.map-task[data-task-id="${derived.id}"]`).count()).toBe(1);expect(await p.locator(`.map-task[data-task-id="${unassigned.id}"]`).count()).toBe(0);
 await p.locator('.wf').screenshot({path:join(SHOTS,"product-focus.png")});
 await p.getByRole("button",{name:"← 이전 보기",exact:true}).click();expect(await p.locator('.to-row').count()).toBe(before);
 await card(p,current.id).focus();await p.keyboard.press("Shift+F10");await p.getByRole("button",{name:"← 이전 보기",exact:true}).click();await p.close();
},30000);

test("드래그 후 인계 확인과 취소를 거쳐 지정한 직원에게 한 번만 배정한다",async()=>{
 const p=await open();await freeTray(p);await card(p,unassigned.id).dragTo(p.locator(`[data-drop-member="${web.id}"]`));
 const dialog=p.getByRole("dialog",{name:"업무 배정",exact:true});await dialog.getByText("승인 자동 응답 금지",{exact:true}).waitFor();
 expect(await p.getByLabel("담당 직원",{exact:true}).inputValue()).toBe(web.id);
 expect(await dialog.getByText("관련 동작 시험",{exact:true}).count()).toBe(1);
 await dialog.screenshot({path:join(SHOTS,"product-assignment.png")});
 await dialog.getByRole("button",{name:"취소",exact:true}).click();expect(store.listDeliveries(project.id).filter(d=>d.taskId===unassigned.id)).toHaveLength(0);
 await card(p,unassigned.id).dragTo(p.locator(`[data-drop-member="${web.id}"]`));await dialog.getByText("승인 자동 응답 금지",{exact:true}).waitFor();
 await dialog.getByRole("button",{name:"배정",exact:true}).click();await dialog.getByText("배정했습니다",{exact:false}).waitFor();
 expect(store.listDeliveries(project.id).filter(d=>d.taskId===unassigned.id)).toHaveLength(1);
 expect(store.listDeliveries(project.id).find(d=>d.taskId===unassigned.id)?.memberId).toBe(web.id);await p.close();
},30000);

test("확정 조건이 없는 후보는 배정할 수 없다",async()=>{
 const p=await open();await freeTray(p);await p.getByRole("button",{name:"자동 반복 실행 후보 배정",exact:true}).click();await p.getByLabel("담당 직원",{exact:true}).selectOption(web.id);
 const d=p.getByRole("dialog");await d.getByText("업무의 목표와 완료 조건이 아직 확정되지 않았습니다",{exact:true}).waitFor();expect(await d.getByRole("button",{name:"배정",exact:true}).isDisabled()).toBe(true);await p.close();
},30000);

test("검토 후 계약 변경은 충돌을 알리고 배정하지 않는다",async()=>{
 const t=ready("검토 중 조건 변경"),p=await open();await assignMenu(p,t);
 store.saveTaskContract(t.id,{kind:"coding",goal:t.title,acceptance:["변경된 기준"]},{author:"대표",authorMemberId:null,authorKind:"owner"});
 await p.getByRole("dialog").getByRole("button",{name:"배정",exact:true}).click();await p.getByRole("dialog").getByRole("alert").waitFor();
 expect(store.listDeliveries(project.id).filter(d=>d.taskId===t.id)).toHaveLength(0);await p.close();
},30000);

test("응답 유실은 영수증을 확인하고 새 배정 요청을 보내지 않는다",async()=>{
 const t=ready("응답 유실 배정"),p=await open();await assignMenu(p,t);let posts=0;
 await p.route(`**/workflow/tasks/${t.id}/assignment`,async route=>{if(route.request().method()==="POST"){posts++;await route.fetch();await route.abort()}else await route.continue()});
 await p.getByRole("dialog").getByRole("button",{name:"배정",exact:true}).click();await p.getByRole("button",{name:"결과 확인",exact:true}).click();
 await p.getByRole("dialog").getByText("배정했습니다",{exact:false}).waitFor();expect(posts).toBe(1);expect(store.listDeliveries(project.id).filter(d=>d.taskId===t.id)).toHaveLength(1);await p.close();
},30000);

test("390px에서 세로로 재배치하고 메뉴와 초점을 유지한다",async()=>{
 const p=await open(390);expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(await p.locator('.to-table').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
 await card(p,current.id).focus();await p.keyboard.press("Enter");await p.getByRole("dialog").waitFor();await p.keyboard.press("Escape");expect(await card(p,current.id).evaluate(e=>document.activeElement===e)).toBe(true);
 await p.screenshot({path:join(SHOTS,"product-mobile.png")});await p.close();
},30000);

test("프로젝트를 바꾸면 이전 배정 검토를 닫는다",async()=>{
 const t=ready("프로젝트 전환 검토"),p=await open();await assignMenu(p,t);
 await p.evaluate(id=>{location.hash=`#/p/${id}/team`},other.id);
 await p.getByRole("dialog",{name:"업무 배정",exact:true}).waitFor({state:"hidden"});
 expect(store.listDeliveries(project.id).filter(d=>d.taskId===t.id)).toHaveLength(0);await p.close();
},30000);

test("별도 저장된 실패 검사 근거를 인계 창에서 읽을 수 있다",async()=>{
 const parent=ready("중단 검사의 원래 업무"),t=ready("실패 근거 인계");store.db.query("UPDATE tasks SET parent_task_id=? WHERE id=?").run(parent.id,t.id);
 const message=store.createMessage({projectId:project.id,taskId:parent.id,memberId:worker.id,who:worker.name,mine:false,kind:"막힘",title:"중단 실패",body:""});
 store.recordReportChecks(message,worker,[{kind:"behavior",name:"중단 입력 검사",result:"fail",command:"bun test stop-handoff",evidence:"중단 뒤 입력이 남았습니다"}],{contractTaskId:parent.id,contractRev:1,evidenceStatus:"missing",reviewNeeded:"실행 대조 필요"});
 const p=await open();await assignMenu(p,t);const d=p.getByRole("dialog");await d.getByText(`${worker.name} · 막힘 · 중단 실패`,{exact:true}).click();
 await d.getByText("중단 뒤 입력이 남았습니다",{exact:true}).waitFor();expect(await d.getByText("bun test stop-handoff",{exact:true}).count()).toBe(1);await p.close();
},30000);
