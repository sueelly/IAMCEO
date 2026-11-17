from pathlib import Path
import sys,os,subprocess,time,json
root=Path(__file__).resolve().parents[2];label=sys.argv[1];args=sys.argv[2:];source=root
if args and args[0]=='baseline':source=root/'evidence/baseline-afc';args=args[1:]
folder=root/'evidence'/(label+'-'+str(time.time_ns()));folder.mkdir();short=Path((root/'evidence/short-root.txt').read_text().strip());temp=short/folder.name;temp.mkdir();home=folder/'home';home.mkdir()
env={'PATH':'/opt/homebrew/bin:/Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/toolchain/node_modules/bun/bin:/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(home),'LANG':'en_US.UTF-8','TMPDIR':str(temp)+'/', 'XDG_STATE_HOME':str(folder/'state'),'XDG_CONFIG_HOME':str(folder/'config'),'XDG_CACHE_HOME':str(folder/'cache'),'IAMCEO_TEST':'1','IAMCEO_HOME':str(folder/'iamceo'),'IAMCEO_PORT':'0','CLAUDE_CONFIG_DIR':str(folder/'claude'),'CODEX_HOME':str(folder/'codex'),'IAMCEO_CORE_BIN':'/usr/bin/false','IAMCEO_CLAUDE_BIN':'/usr/bin/false','IAMCEO_CODEX_BIN':'/usr/bin/false','IAMCEO_CORE_SOCKET':str(temp/'none.sock'),'IAMCEO_HERDR_SOCKET':str(temp/'no-herdr.sock'),'PLAYWRIGHT_BROWSERS_PATH':'/Users/hyejookim/Library/Caches/ms-playwright','REVIEW_STAGE':str(folder),'STAGE_FIXTURE_ROOT':str(short),'IAMCEO_E2E_SHOTS':str(folder/'shots')}
assert not any(k.startswith(('HC_','HERDR_')) for k in env)
bun='/Users/hyejookim/Programming/01_Ing/.runtime/IAMCEO/toolchain/node_modules/bun/bin/bun.exe';cmd=['/usr/bin/sandbox-exec','-f',str(root/'scripts/stage-recovery/isolated.sb'),bun]
if args and args[0]=='test':cmd+=['test','--preload',str(root/'scripts/stage-recovery/retain.ts'),*args[1:]]
else:cmd+=args
start=time.monotonic()
with (folder/'stdout.txt').open('wb') as out,(folder/'stderr.txt').open('wb') as err:
 p=subprocess.run(cmd,cwd=source,env=env,stdout=out,stderr=err)
record={'label':label,'cwd':str(source),'argv':cmd,'exitCode':p.returncode,'seconds':round(time.monotonic()-start,3),'isolated':True,'logDir':str(folder)};(folder/'result.json').write_text(json.dumps(record,indent=2)+'\n');text=(folder/'stdout.txt').read_text(errors='replace')+'\n'+(folder/'stderr.txt').read_text(errors='replace');print('\n'.join(x for x in text.splitlines() if any(y in x for y in ('(fail)',' pass',' fail','Ran ','error:','Error:')))[-7000:]);print(json.dumps(record));sys.exit(p.returncode)
