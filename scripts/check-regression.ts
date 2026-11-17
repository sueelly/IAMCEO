// Compare raw Bun records, including process status. Known failures remain failures,
// but may be accepted as an explicitly bounded baseline; extra occurrences are never deduplicated.
import { readFileSync } from 'node:fs';
export function parseRegression(text: string, exit: number) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split(/\r?\n/);
  const footer = lines.findIndex(x => /^\d+ tests? failed:/.test(x));
  const execution = footer < 0 ? lines : lines.slice(0, footer);
  const names = execution.flatMap(x => /^\(fail\) (.*?)(?: \[[\d.]+(?:ms|s)\])?$/.exec(x)?.[1] ?? []);
  const count = (kind: string) => [...clean.matchAll(new RegExp('^\\s+(\\d+) '+kind+'\\s*$', 'gm'))];
  const passes=count('pass'), fails=count('fail'), skips=count('skip');
  const pass=Number(passes[0]?.[1] ?? -1), fail=Number(fails[0]?.[1] ?? -1), skip=Number(skips[0]?.[1] ?? 0);
  const totals=[...clean.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)];
  const errors = /unhandled(?:\s+(?:error|rejection))?|\d+ errors?\b|error: Cannot find module|SyntaxError:/i.test(clean);
  const valid = passes.length===1 && fails.length===1 && totals.length===1 && skips.length<=1 && fail===names.length &&
    Number(totals[0]?.[1])===pass+fail+skip && !errors && exit===(fail ? 1 : 0);
  return {valid,exit,pass,fail,skip,names,errors};
}
export function compareRegression(base: string, baseExit: number, candidate: string, candidateExit: number) {
  const before=parseRegression(base,baseExit),after=parseRegression(candidate,candidateExit);
  const counts=(names:string[])=>{const out=new Map<string,number>();for(const n of names)out.set(n,(out.get(n)??0)+1);return out};
  const allowed=counts(before.names),actual=counts(after.names);
  const extra=[...actual].filter(([name,n])=>n>(allowed.get(name)??0));
  return {ok:before.valid && after.valid && after.pass>=before.pass && after.skip<=before.skip && extra.length===0,before,after,extra};
}
if(import.meta.main){
  const [baseline,baseExit,candidate,candidateExit]=process.argv.slice(2);
  if(!baseline||!candidate||!/^\d+$/.test(baseExit??'')||!/^\d+$/.test(candidateExit??''))throw Error('baseline log/exit and candidate log/exit are required');
  const result=compareRegression(readFileSync(baseline,'utf8'),Number(baseExit),readFileSync(candidate,'utf8'),Number(candidateExit));
  console.log(JSON.stringify(result));process.exit(result.ok?0:1);
}
