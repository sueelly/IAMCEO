import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import type { Bus } from "../server/bus.ts";
import { startServer } from "../server/http.ts";
import { fixture } from "./fixtures/harness-fixture.ts";

function retainBrowserFailure(f: ReturnType<typeof fixture>, error: unknown) {
  const root = process.env.IAMCEO_TEST_RUN_ROOT;
  if (!root) return;
  const dir = mkdtempSync(join(root, "owner-home-"));
  writeFileSync(join(dir, "failure.log"), error instanceof Error ? error.stack || error.message : String(error), {mode:0o600});
  writeFileSync(join(dir, "iamceo.db"), f.store.db.serialize(), {mode:0o600});
}

test("홈 지시를 보내고 같은 업무의 두 명령에서 각각 자기 질문·보고·자료만 연다 (PC·390)", async () => {
  const f = fixture(), pr = f.project.id;
  const task = f.store.saveTask({projectId:pr,memberId:f.lead.id,who:f.lead.name,title:"주문서 검토"}).task;
  for (let i=1;i<=4;i++) f.store.createTodo({projectId:pr,taskId:task.id,title:`기존 대표 할 일 ${i}`});
  const todo = f.store.createTodo({projectId:pr,taskId:task.id,title:"환불 기준 확정"});
  const file = f.store.createFile({projectId:pr,taskId:task.id,memberId:f.worker.id,title:"가격표 원본",kind:"document", body:"단가 원본 문서 12건"});
  const time = new Date().toISOString();
  const key = (id:string) => ({id,kind:"command",at:time,projectId:pr,taskId:task.id});
  const rows = [
    {...key("order-two"),title:"환불 문구 수정",stage:"owner",detail:"대표의 환불 기준을 기다립니다",questions:[{kind:"todo",id:todo.id,title:todo.title}],result:null},
    {...key("order-one"),title:"가격표 확인",stage:"result",detail:"원본 가격표 대조를 통과했습니다",questions:[],result:{kind:"완료",messageId:"price-report",title:"가격표 대조 완료",at:time,fileIds:[file.id]},milestones:[{kind:"application",at:time,actor:"철수",evidence:"12개 가격 반영",commit:null,messageId:"price-report",fileIds:[file.id]}]},
    {...key(task.id),kind:"task",title:"주문서 검토",stage:"waiting",detail:"원본 인쇄본 대기",questions:[],result:null},
  ];
  const baseServer = await startServer({config:f.config,store:f.store,bus:(f.store as unknown as {bus:Bus}).bus,orch:f.orch,delivery:f.orch.deliveryRecovery});
  const base=baseServer.urls[0]!;
  const browser=await chromium.launch();
  try {
    for (const width of [1440,390]) {
      const page = await browser.newPage({viewport:{width,height:width===390?844:980}});
      page.setDefaultTimeout(3500);
      try {
        await page.addInitScript(code=>localStorage.setItem("iamceo.accessCode",code),f.config.accessCode);
        const requests: URL[] = [];
        await page.route(`**/api/projects/${pr}/owner-commands*`,route=>{
          const url = new URL(route.request().url()); requests.push(url);
          return route.fulfill({json:url.searchParams.has("cursor") ? {items:[{...rows[2],id:"older",title:"이전 접수 업무"}],nextCursor:null} : {items:rows,nextCursor:"older"}});
        });
        await page.route("**/api/messages/price-report",route=>route.fulfill({json:{id:"price-report",projectId:pr,taskId:task.id,title:"가격표 대조 완료",body:"원래 요청의 가격 12건을 원본과 대조했습니다.",at:time}}));
        await page.goto(`${base}/#/p/${pr}/home`);
        const list=page.getByRole("region",{name:"대표 명령"});
        await list.waitFor();
        const first=list.locator('[data-command-id="order-one"]'),second=list.locator('[data-command-id="order-two"]');
        await second.waitFor();
        expect(requests[0]!.searchParams.get("limit")).toBe("5");
        const todos = page.getByRole("region",{name:"내가 할 일"});
        expect((await todos.boundingBox())!.y).toBeLessThan((await list.boundingBox())!.y);
        expect(await todos.getByRole("checkbox").count()).toBe(3);
        await page.locator('.conn[data-state="online"]').first().waitFor({state:"attached"});
        if(process.env.IAMCEO_E2E_SHOTS){mkdirSync(process.env.IAMCEO_E2E_SHOTS,{recursive:true});await page.screenshot({path:join(process.env.IAMCEO_E2E_SHOTS,`owner-home-${width}.png`)});}
        await list.getByRole("button",{name:/이전 명령/}).click();
        await list.getByRole("button",{name:"이전 접수 업무"}).waitFor();
        await list.getByRole("button",{name:"최근 명령으로"}).click();
        await second.waitFor();
        expect(await second.getByRole("link",{name:todo.title}).getAttribute("href")).toBe(`#/p/${pr}/home/${todo.id}`);
        expect(await first.innerText()).toContain("원본 가격표 대조를 통과했습니다");
        expect(await second.innerText()).not.toContain("가격표 대조 완료");
        expect(await list.locator(`[data-command-id="${task.id}"]`).innerText()).toContain("기존 업무");
        await first.getByRole("button",{name:"가격표 대조 완료"}).click();
        expect(await first.getByText("원래 요청의 가격 12건을 원본과 대조했습니다.").innerText()).toContain("12건");
        expect(await first.getByRole("link", {name:"가격표 원본"}).getAttribute("href")).toBe(`#/p/${pr}/files/${file.id}`);
        expect(await second.getByRole("link",{name:/자료/}).count()).toBe(0);
        await first.getByRole("button",{name:"가격표 확인",exact:true}).click();
        await first.getByText("담당자 적용 기록").waitFor();
        expect(await first.innerText()).toContain("12개 가격 반영");
        expect(await second.innerText()).not.toContain("12개 가격 반영");
        await first.getByRole("link",{name:"가격표 원본"}).first().click();
        await page.getByText("단가 원본 문서 12건").first().waitFor();
        await page.goBack();
        await second.getByRole("link",{name:todo.title}).click();
        await page.waitForFunction(id=>document.activeElement?.closest("[data-todo]")?.getAttribute("data-todo")===id,todo.id);
        expect(f.store.requireTodo(todo.id).done).toBe(false);
        const input=page.getByRole("textbox",{name:"입력칸"});
        await input.fill("이번 주 승인된 결과물을 정리해 주세요");
        const [posted]=await Promise.all([page.waitForRequest(r=>r.url().endsWith(`/${pr}/messages`) && r.method()==="POST"),page.getByRole("button",{name:"보내기",exact:true}).click()]);
        expect(posted.postDataJSON()).toMatchObject({text:"이번 주 승인된 결과물을 정리해 주세요",intent:"execute",targetMemberId:null});
        expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

      } finally {await page.close();}
    }
  } catch (error) { retainBrowserFailure(f,error); throw error; } finally {await browser.close();await baseServer.stop();}
},40000);

test("실행기를 꺼 둔 홈에서 현황만 보내고 정확한 명령 아래 DB 답변을 연다 (PC·390)", async () => {
  const f = fixture();
  const project = f.store.createProject({name:"상태 조회 시험", cwd:f.project.cwd, runnerEnabled:false});
  f.store.createTodo({projectId:project.id, title:"결제일 확정"});
  const server = await startServer({config:f.config, store:f.store, bus:(f.store as unknown as {bus:Bus}).bus, orch:f.orch, delivery:f.orch.deliveryRecovery});
  const browser = await chromium.launch();
  try {
    for (const width of [1440,390]) {
      const page = await browser.newPage({viewport:{width,height:860}});
      page.setDefaultTimeout(3500);
      try {
        await page.addInitScript(code=>localStorage.setItem("iamceo.accessCode",code),f.config.accessCode);
        await page.goto(server.urls[0] + "/#/p/" + project.id + "/home");
        await page.locator('.hm > [data-gate="runner_off"]').waitFor();
        const input = page.getByRole("textbox",{name:"입력칸"});
        await input.fill("결제 기능을 배포해");
        const send = page.getByRole("button",{name:"보내기",exact:true});
        expect(await send.isDisabled()).toBe(true);
        await input.fill("지금 다 끝났어?");
        const [response] = await Promise.all([
          page.waitForResponse(r=>r.url().endsWith("/"+project.id+"/messages") && r.request().method()==="POST"),
          send.click(),
        ]);
        expect(response.ok()).toBe(true);
        const saved = await response.json();
        const row = page.locator('[data-command-id="'+saved.id+'"]');
        await row.getByText("현재 상태를 조회해 답변했습니다.").waitFor();
        await row.getByRole("button",{name:"상태 조회 시험 현황"}).click();
        await row.getByText(/대표 할 일 1건/).waitFor();
        expect(f.store.listDeliveries(project.id)).toHaveLength(0);
      } finally { await page.close(); }
    }
  } catch (error) { retainBrowserFailure(f,error); throw error; } finally { await browser.close(); await server.stop(); }
}, 30_000);

test("선택한 대화 업무의 초안을 보존하고 홈 명령을 독립된 ID로 접수한다", async () => {
  const f = fixture(), projectId = f.project.id;
  const task = f.store.saveTask({projectId,memberId:f.worker.id,who:f.worker.name,title:"다른 대화 업무"}).task;
  f.store.createMessage({projectId,taskId:task.id,memberId:f.worker.id,kind:"진행",title:"별도 대화 업무를 확인 중"});
  const server = await startServer({config:f.config,store:f.store,bus:(f.store as unknown as {bus:Bus}).bus,orch:f.orch,delivery:f.orch.deliveryRecovery});
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(4_000);
  try {
    await page.addInitScript(code => localStorage.setItem("iamceo.accessCode",code), f.config.accessCode);
    const navigate = (tab: string) => page.evaluate(hash => { location.hash = hash; }, "#/p/" + projectId + "/" + tab);
    await page.goto(server.urls[0] + "/#/p/" + projectId + "/thread");
    const input = page.getByRole("textbox",{name:"입력칸"});
    await page.locator(".cmp-task").filter({hasText:task.title}).click();
    await input.fill("대화에 남겨 둔 초안");
    await navigate("home");
    const homeInput = page.getByPlaceholder("새 명령 입력");
    expect(await homeInput.inputValue()).toBe("");
    const text = "월별 매출 비교표를 만들어 주세요";
    await homeInput.fill(text);
    const [response] = await Promise.all([
      page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/" + projectId + "/messages")),
      page.getByRole("button",{name:"보내기",exact:true}).click(),
    ]);
    expect(response.ok()).toBe(true);
    const saved = await response.json();
    expect(saved.taskId).not.toBe(task.id);
    const command = page.locator('[data-command-id="'+saved.id+'"]');
    await command.getByRole("button",{name:text, exact:true}).click();
    await command.getByRole("button",{name:"명령 원문"}).click();
    await command.locator(".md").getByText(text,{exact:true}).waitFor();
    await navigate("thread");
    expect(await input.inputValue()).toBe("대화에 남겨 둔 초안");
    expect(await page.locator('.cmp-task[aria-pressed="true"]').innerText()).toBe(task.title);
  } catch (error) { retainBrowserFailure(f,error); throw error; } finally { await browser.close(); await server.stop(); }
}, 20_000);
