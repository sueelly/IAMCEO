import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const folder='docs/mockups/agent-a-integration-2026-11-12/';
const html=await readFile(folder+'renderer-check.html','utf8');
const design=await readFile(folder+'design-renderer.html','utf8');
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
const errors=[],requests=[],checks=[];
page.on('pageerror',e=>errors.push(String(e)));
page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
await page.route('**/*',r=>r.abort());
async function load(width){await page.setViewportSize({width,height:1000});await page.setContent('<iframe sandbox="allow-scripts" style="border:0;width:100%;height:2200px" id="demo"></iframe><style>body{margin:0}</style>');await page.locator('iframe').evaluate((e,s)=>e.srcdoc=s,html);await page.frameLocator('iframe').locator('[data-action=send]').waitFor({state:'attached'});return page.frameLocator('iframe');}
const action=(f,a)=>f.locator('[data-action="'+a+'"]');
async function click(f,a){await action(f,a).filter({visible:true}).first().click();}
async function review(f,width){if(width<=820)await click(f,'panel-review');}
async function send(f,width,text='실제 제공 범위에 맞춰 약속을 줄여 주세요.'){await review(f,width);await f.locator('#request').fill(text);await click(f,'send');}
async function waitResult(f){await f.locator('#alerts').getByText(/요청 결과:/).first().waitFor();}
async function noOverflow(f){return f.locator('body').evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));}
try{
 for(const width of [320,390,768,1440]){
  let f=await load(width);
  let z=await noOverflow(f);assert.ok(z.scroll<=z.width+1,JSON.stringify(z));
  await send(f,width);
  await f.locator('[data-action=select][data-doc=B]').filter({visible:true}).first().click();
  await waitResult(f);assert.match(await f.locator('.doc-head h2').innerText(),/자료 B/);
  assert.equal(await f.locator('#thread-demo-comment-1').count(),0);
  await click(f,'notification');assert.match(await f.locator('.doc-head h2').innerText(),/자료 A/);
  await click(f,'preview');await f.getByRole('dialog').waitFor();
  await click(f,'apply');assert.equal(await f.locator('#version').inputValue(),'2');
  await f.locator('#version').selectOption('1');await review(f,width);
  assert.equal(await f.locator('#thread-demo-comment-1').count(),1);
  assert.match(await f.locator('.paper .lead').innerText(),/모두 자동/);
  await click(f,'reply-toggle');await f.getByRole('textbox',{name:'답글',exact:true}).fill('다음에도 과장 표현은 확인해 주세요.');await click(f,'reply');
  assert.match(await f.locator('.replies').innerText(),/과장 표현/);
  await click(f,'chat');assert.equal(await f.locator('.summary-card').count(),1);
  await click(f,'summary');assert.equal(await f.locator('#version').inputValue(),'1');
  z=await noOverflow(f);assert.ok(z.scroll<=z.width+1);
  await click(f,'reset');await f.locator('.scenario summary').click();await click(f,'empty');assert.match(await f.locator('.chat-page').innerText(),/아직 연결한 자료/);
  checks.push({width,flow:'A→B→A notification / diff→apply / v1 / reply / summary→origin / reset→empty',overflow:z});
 }
 let f=await load(1440);
 await f.locator('.scenario summary').click();await click(f,'fail-next');await send(f,1440);await waitResult(f);
 assert.match(await f.locator('.thread-meta').innerText(),/연결 실패/);await click(f,'retry');await f.locator('.thread-meta').getByText('변경안 준비',{exact:true}).waitFor();
 await click(f,'reassign');assert.match(await f.locator('.thread-meta').innerText(),/인계 검토/);
 await f.locator('.source summary').first().click();assert.match(await f.locator('.source dl').innerText(),/전송 때 담당\s+문서 담당 · 배정 1/);
 await click(f,'adopt');await f.locator('.source summary').first().click();assert.match(await f.locator('.source dl').innerText(),/전송 때 담당\s+문서 담당 · 배정 1/);
 await click(f,'advance');await click(f,'preview');assert.match(await f.getByRole('dialog').innerText(),/최신 정본은 v2/);
 assert.equal(await action(f,'apply').count(),0);await click(f,'rebase');assert.match(await f.locator('.diff .after').innerText(),/다른 요청에서 검증 범위/);
 await click(f,'close-modal');await click(f,'unknown-next');await click(f,'preview');await click(f,'apply');
 assert.match(await f.locator('.thread-meta').innerText(),/미확인/);await click(f,'reconcile');assert.equal(await f.locator('#version').inputValue(),'3');
 assert.equal(await f.locator('#version option').count(),3);checks.push({edge:'failed→retry; assignment adoption preserves original owner; revision conflict→new proposal preserving newer text; lost response→lookup without duplicate'});
 await click(f,'reset');await send(f,1440);await f.locator('.scenario summary').click();await click(f,'reassign');await waitResult(f);assert.match(await f.locator('.thread-meta').innerText(),/인계 검토/);assert.match(await f.locator('.answer-author').innerText(),/문서 담당/);checks.push({edge:'queued request→reassign→late original-worker answer'});
 await click(f,'reset');await send(f,1440);await click(f,'stop');await page.waitForTimeout(2100);assert.match(await f.locator('.thread-meta').innerText(),/중단 요청됨/);await click(f,'confirm-stop');assert.match(await f.locator('.thread-meta').innerText(),/중단 확인/);
 await click(f,'reset');await send(f,1440);await waitResult(f);await click(f,'preview');await click(f,'reject');assert.equal(await f.locator('#version').inputValue(),'1');assert.match(await f.locator('.thread-meta').innerText(),/거절됨/);
 await click(f,'reset');await f.locator('#request-kind').selectOption('question');await f.locator('#request').fill('이 문구가 과장인지 알려 주세요.');await click(f,'send');await waitResult(f);assert.match(await f.locator('.thread-meta').innerText(),/답변 도착/);assert.equal(await action(f,'preview').count(),0);
 checks.push({edge:'stop request≠ack; reject leaves v1; question answers without approval'});
 // Screenshots render the same kit-wrapped document directly, avoiding a fixed-height screenshot crop.
 await page.setContent(html);await page.setViewportSize({width:1440,height:1100});
 await page.locator('#request').fill('실제 제공 범위에 맞춰 문장을 줄여 주세요.');await page.locator('[data-action=send]').click();await page.locator('#alerts').getByText(/요청 결과:/).waitFor();
 await page.screenshot({path:folder+'pc-review.png',fullPage:true});await page.locator('[data-action=preview]').click();await page.screenshot({path:folder+'pc-change.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.setContent(html);await page.locator('[data-action=panel-review]').click();await page.locator('#request').fill('실제 제공 범위로 줄여 주세요.');await page.locator('[data-action=send]').click();await page.locator('#alerts').getByText(/요청 결과:/).waitFor();await page.screenshot({path:folder+'phone-review.png',fullPage:true});
 await page.locator('[data-action=panel-doc]').click();await page.screenshot({path:folder+'phone-document.png',fullPage:true});
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});await page.setContent(design);let z=await noOverflow(page);assert.ok(z.scroll<=z.width+1,JSON.stringify(z));checks.push({designWidth:width,overflow:z});}
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 const result={checks,errors,externalRequests:requests,scope:'Local Chromium, real artifact-kit wrapper, allow-scripts sandbox. No live IAMCEO/Agent-A calls.'};
 await writeFile(folder+'verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
