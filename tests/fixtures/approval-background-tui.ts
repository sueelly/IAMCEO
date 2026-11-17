// Owned PTY fixture: no provider/model and no execution of the displayed command.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir=process.env.IAMCEO_INTEGRATION_FIXTURE;
if(!dir?.startsWith('/private/tmp/iqia-'))throw new Error('Explicit isolated integration root required');
const args=process.argv.slice(2),session=args[args.indexOf('--session-id')+1];
if(!session||!process.env.CLAUDE_CONFIG_DIR)throw new Error('Explicit fake session required');
const root=join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));mkdirSync(root,{recursive:true});
const record=(v:unknown)=>appendFileSync(join(root,session+'.jsonl'),JSON.stringify(v)+'\n');
const note=(v:unknown)=>appendFileSync(join(dir!,'events.jsonl'),JSON.stringify(v)+'\n');
let state='idle',input='',background=false;
const osc=(s:string)=>process.stdout.write(`\x1b]7501;state=${s}\x07`);
const paint=(s:string)=>process.stdout.write(`\x1b[2J\x1b[H${s.replace(/\n/g,'\r\n')}`);
function composer(){paint(`Isolated integration fixture: no model\n✻ Worked for 1s · done\n${'─'.repeat(100)}\n❯ ${input}\n${'─'.repeat(100)}\n  ⏵⏵ bypass permissions on${background?' · 1 shell, 2 monitors':''}\n`);}
function finish(){state='idle';background=true;record({type:'assistant',sessionId:session,isSidechain:false,message:{role:'assistant',content:[{type:'text',text:'Waiting for isolated background result'}],stop_reason:'end_turn'}});composer();osc('idle');}
function submit(){
 if(!input.trim())return;const text=input;input='';state='working';osc('working');
 note({event:'received',text,at:new Date().toISOString()});record({type:'user',sessionId:session,cwd:process.cwd(),isSidechain:false,message:{role:'user',content:text}});
 setTimeout(()=>{
  if(text.includes('INTEGRATION_ORIGINAL')){state='blocked';paint(readFileSync(join(import.meta.dir,'native-prompts/claude-bash-permission.txt'),'utf8'));osc('blocked:kind=permission');note({event:'window'});}
  else finish();
 },250);
}
process.stdin.setRawMode?.(true);process.stdin.setEncoding('utf8');process.stdout.write('\x1b[?2004h');
process.stdin.on('data',(chunk:string)=>{
 for(const m of chunk.matchAll(/\x1b\[200~([\s\S]*?)\x1b\[201~|\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g)){
  if(state==='blocked'){
   note({event:'key',key:m[0]});
   if(m[0]==='\r'||m[0]==='\n'||m[0]==='1'){note({event:'choose',n:1});state='working';osc('working');setTimeout(finish,250);}
   continue;
  }
  if(state!=='idle')continue;
  if(m[1]!==undefined)input+=m[1];else if(m[0]==='\r'||m[0]==='\n')submit();else if(!m[0].startsWith('\x1b'))input+=m[0];
 }
 if(state==='idle')composer();
});
setInterval(()=>{if(background&&existsSync(join(dir!,'clear'))){background=false;composer();}},50);
composer();osc('idle');
