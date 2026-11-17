// Browser verification of this standalone design example; no IAMCEO service is started.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../../..');
const require=createRequire(join(process.env.IAMCEO_VERIFY_DEPENDENCIES||root,'package.json'));
const {chromium}=require('playwright');
const shots=join(here,'screenshots');mkdirSync(shots,{recursive:true});
const browser=await chromium.launch();
const context=await browser.newContext({viewport:{width:1600,height:1000},offline:true});
const page=await context.newPage(),errors=[],network=[];let passed=0;
page.on('pageerror',e=>errors.push(e.message));
page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url())});
const url=pathToFileURL(join(here,'index.html')).href;
async function test(name,fn){await fn();passed++;console.log('PASS '+name)}
const count=s=>page.locator(s).count();
try{
 await page.goto(url);
 await test('offline overview: 13 unique tasks, four lanes, completed/now/next aligned',async()=>{
  assert.equal(await count('.task-card'),13);assert.equal(await count('.lane'),4);
  assert.equal(await count('.past .task-card[data-state=done]'),3);
  assert.equal(await count('.now .task-card[data-state=blocked]'),2);
  assert.equal(await count('.next .task-card'),3);
  assert.equal(await page.locator('#queue-count').textContent(),'3건');
  const xs=await page.locator('.lane-cell.now').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().left));
  assert.ok(xs.every(x=>Math.abs(x-xs[0])<1));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(shots,'overview.png'),fullPage:true});
 });
 await test('blocked historical record remains current; detail preserves unfinished status',async()=>{
  await page.locator('[data-open=c2]').click();
  assert.equal(await page.locator('#detail').isVisible(),true);
  assert.ok((await page.locator('#detail').textContent()).includes('옛 기록이지만 완료가 확인되지 않아'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-open=c2]').evaluate(e=>document.activeElement===e),true);
 });
 await test('right click shows only direct links and restores the previous filter',async()=>{
  await page.locator('[data-filter=blocked]').click();await page.locator('[data-id=c2]').click({button:'right'});
  assert.deepEqual((await page.locator('.task-card').evaluateAll(els=>els.map(e=>e.dataset.id))).sort(),['c1','c2','c3','d2','n2']);
  assert.equal(await count('.lane'),3);assert.equal(await page.locator('[data-filter=all]').textContent(),'전체13');
  await page.locator('.edge').first().waitFor({state:'attached'});
  assert.ok(await count('.edge')>=4);await page.screenshot({path:join(shots,'focused.png'),fullPage:true});
  await page.locator('#restore').click();assert.equal(await count('.task-card'),2);
  assert.equal(await page.locator('[data-filter=blocked]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-filter=all]').click();
 });
 await test('family expansion includes derived family and adjacent sequence only',async()=>{
  await page.locator('[data-id=c2]').click({button:'right'});await page.locator('[data-depth=family]').click();
  assert.deepEqual((await page.locator('.task-card').evaluateAll(els=>els.map(e=>e.dataset.id))).sort(),['c1','c2','c3','d1','d2','n1','n2','n3']);
  await page.locator('#restore').click();
 });
 await test('drag opens handoff; cancel performs no assignment',async()=>{
  await page.locator('[data-id=u1]').dragTo(page.locator('[data-drop=web]'));
  await page.locator('#assignment').waitFor({state:'visible'});
  assert.equal(await page.locator('#assignment-title').textContent(),'웹 담당에게 배정');
  assert.ok((await page.locator('#assignment').textContent()).includes('원래 지시'));
  assert.ok((await page.locator('#assignment').textContent()).includes('완료 조건'));
  assert.ok((await page.locator('#assignment').textContent()).includes('기존 승인·중단 보호·순서 조건을 유지'));
  assert.equal(await count('#queue [data-id=u1]'),1);
  await page.screenshot({path:join(shots,'assignment.png'),fullPage:true});
  await page.locator('#assignment').getByRole('button',{name:'취소',exact:true}).click();
  assert.equal(await count('#queue [data-id=u1]'),1);assert.equal(await count('[data-member=web] [data-id=u1]'),0);
 });
 await test('confirmed handoff moves the same task once into the next queue',async()=>{
  await page.locator('[data-id=u1]').dragTo(page.locator('[data-drop=web]'));
  await page.locator('#confirm-assignment').click();
  assert.equal(await count('[data-member=web] .next [data-id=u1]'),1);
  assert.equal(await count('#queue [data-id=u1]'),0);assert.equal(await count('.task-card'),13);
  assert.equal(await page.locator('#queue-count').textContent(),'2건');
  assert.equal(await page.locator('[data-id=u1]').getAttribute('draggable'),null);
 });
 await test('unapproved candidate cannot be assigned through dragging',async()=>{
  await page.locator('[data-id=u3]').dragTo(page.locator('[data-drop=native]'));
  assert.equal(await page.locator('#confirm-assignment').isDisabled(),true);
  assert.ok((await page.locator('#assignment [role=alert]').textContent()).includes('승인이 아직 확정되지'));
  await page.keyboard.press('Escape');assert.equal(await count('#queue [data-id=u3]'),1);
 });
 await test('keyboard menu supports assignment without dragging',async()=>{
  await page.locator('[data-more=u2]').focus();await page.keyboard.press('Enter');
  await page.locator('[data-assign=u2]').click();await page.locator('#member-pick').selectOption('harness');
  await page.locator('[data-preview=u2]').click();
  assert.equal(await page.locator('#assignment-title').textContent(),'하네스 검토에게 배정');
  await page.locator('#confirm-assignment').click();
  assert.equal(await count('[data-member=harness] .next [data-id=u2]'),1);
  await page.locator('[data-open=c2]').focus();await page.keyboard.press('Shift+F10');
  assert.equal(await page.locator('#focusbar').isVisible(),true);await page.locator('#restore').click();
 });
 await test('map uses the same tasks; reload restores synthetic fixture',async()=>{
  await page.locator('[data-view=map]').click();await page.locator('.edge').first().waitFor({state:'attached'});assert.ok(await count('.edge')>=9);
  assert.equal(await count('.task-card'),13);await page.reload();
  assert.equal(await page.locator('#queue-count').textContent(),'3건');
 });
 await test('1440px desktop remains aligned without clipping',async()=>{
  await page.setViewportSize({width:1440,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.locator('.board').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  await page.screenshot({path:join(shots,'overview-1440.png'),fullPage:true});
 });
 await test('390px mobile reflows without horizontal overflow and supports menu focus',async()=>{
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(shots,'mobile.png'),fullPage:true});
  await page.locator('[data-more=c2]').click();await page.locator('[data-focus=c2]').click();
  assert.equal(await count('.task-card'),5);await page.locator('#restore').click();
  await page.locator('[data-more=u1]').click();await page.locator('[data-assign=u1]').click();
  await page.locator('[data-preview=u1]').click();
  assert.equal(await page.locator('#assignment').evaluate(e=>e.scrollWidth<=e.clientWidth),true);
  await page.keyboard.press('Escape');
 });
 await test('no JavaScript errors or network dependencies',async()=>{assert.deepEqual(errors,[]);assert.deepEqual(network,[])});
 console.log(JSON.stringify({passed,failed:0,offline:true,screenshots:shots}));
}finally{await browser.close()}
