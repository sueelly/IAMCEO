import { expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startServer } from '../server/http.ts';
import { composer, createQueueStatusFixture } from './fixtures/queue-status-runtime.ts';

for (const [name, width, height] of [['desktop',1280,900],['narrow',390,844]] as const) {
  test(`approval receipt and ended background coexist in HTTP/UI at ${width}px`, async () => {
    const f = await createQueueStatusFixture(1);
    const server = await startServer({ config: f.config, bus: f.bus, store: f.store, orch: f.orch, delivery: f.orch.deliveryRecovery });
    const base = `http://127.0.0.1:${server.port}`; f.orch.setServerUrl(base);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height } });
    const errors: string[]=[]; page.on('pageerror',e=>errors.push(e.message));
    const root=resolve('evidence/screens-integration');mkdirSync(root,{recursive:true});
    try {
      await page.addInitScript(code=>localStorage.setItem('iamceo.accessCode',code),f.config.accessCode);
      const task=f.orch.saveTask(f.member,{title:'Integration browser original'}).task;
      const original=f.store.enqueue({projectId:f.project.id,memberId:f.member.id,taskId:task.id,kind:'instruction',text:'BROWSER_CROSS_ORIGINAL',wake:true});
      await f.orch.pump(f.member.id);
      const terminal=f.terminals.get(f.store.requireMember(f.member.id).paneId!)!;
      terminal.status={state:'blocked',kind:'permission',app:'claude-code'};
      f.setScreen(readFileSync(join(import.meta.dir,'fixtures/native-prompts/claude-bash-permission.txt'),'utf8'));
      f.setOnKeys(()=>{f.setScreen(composer('  ⏵⏵ bypass permissions on · 1 shell, 2 monitors'));f.done();});
      await page.goto(`${base}/#/p/${f.project.id}/inbox`);
      const card=page.locator('article.ibx-approval',{hasText:f.member.name});
      await card.locator('.apv-opt').first().click();
      // Keep the existing protection against confirming immediately after selection/layout movement.
      await page.waitForTimeout(700);
      const [answer]=await Promise.all([
        page.waitForResponse(r=>r.url().endsWith('/prompt/answer')&&r.request().method()==='POST',{timeout:10000}),
        card.locator('.apv-confirm__go').click(),
      ]);
      const request=JSON.parse(answer.request().postData()!),receipt=await answer.json();
      expect(answer.status()).toBe(200);expect(receipt).toMatchObject({status:'answered',terminal:'accepted'});
      await card.locator('.npc-stages').waitFor();
      expect(await card.innerText()).toContain('CLI 상태');
      await page.screenshot({path:join(root,`${name}-receipt.png`),fullPage:true});
      const headers={Authorization:`Bearer ${f.config.accessCode}`,'content-type':'application/json'};
      const same=await fetch(`${base}/api/members/${f.member.id}/prompt/answer`,{method:'POST',headers,body:JSON.stringify(request)});
      expect(await same.json()).toEqual(receipt);
      const changed=await fetch(`${base}/api/members/${f.member.id}/prompt/answer`,{method:'POST',headers,body:JSON.stringify({...request,option:4})});
      expect(changed.status).toBe(409);
      for(let i=0;i<400&&f.store.requireMember(f.member.id).executionState?.phase!=='ended';i++)await Bun.sleep(5);
      expect(f.store.requireMember(f.member.id).executionState?.phase).toBe('ended');
      await page.goto(`${base}/#/p/${f.project.id}/team/${f.member.id}`);
      await page.locator('.tm-status').filter({hasText:'일하는 중'}).first().waitFor();
      const raw=await (await fetch(`${base}/api/members/${f.member.id}`,{headers})).json();
      expect(raw.status).toBe('working');expect(raw.executionState.phase).toBe('ended');expect(raw.blockedReason).toBeNull();
      expect(f.keys).toHaveLength(1);expect(f.writes).toHaveLength(1);expect(f.store.requireDelivery(original.id).status).toBe('delivered');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect(errors).toHaveLength(0);
      await page.screenshot({path:join(root,`${name}-background.png`),fullPage:true});
      writeFileSync(join(root,`${name}-proof.json`),JSON.stringify({request,receipt,member:{status:raw.status,blockedReason:raw.blockedReason,executionState:raw.executionState},originalId:original.id,originalInputs:f.writes.length,approvalInputs:f.keys.length,changedStatus:changed.status,errors},null,2));
      f.setScreen(composer('  ⏵⏵ bypass permissions on · 0 shells, 0 monitors'));
      await page.locator('.tm-status').filter({hasText:'대기'}).first().waitFor();
    } finally {await page.close();await browser.close();await server.stop();await f.stop();}
  },30000);
}
