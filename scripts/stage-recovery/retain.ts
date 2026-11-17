import { plugin } from 'bun';
import { readFileSync, appendFileSync } from 'node:fs';
const short=process.env.STAGE_FIXTURE_ROOT!;
plugin({name:'retain-owned-stage-fixtures',setup(b){b.onLoad({filter:/(tests|review)\/.*\.ts$/},a=>{
 let s=readFileSync(a.path,'utf8'),original=s;
 s=s.replace(/mkdtempSync\(['"]\/private\/tmp\/[^'"]+['"]\)/g,()=>`mkdtempSync(${JSON.stringify(short+'/f-')})`);
 s=s.replaceAll("'../../base/server/", "'/Users/hyejookim/Programming/01_Ing/.worktrees/IAMCEO/task-stage-review-20261117/base/server/");
 for(const x of ['rmSync(dir, { recursive: true });','rmSync(dir, { recursive: true, force: true });','rmSync(home, { recursive: true });','rmSync(f.dir, { recursive: true, force: true });'])s=s.replaceAll(x,'void 0; /* owned fixtures retained */');
 if(s!==original)appendFileSync(process.env.REVIEW_STAGE+'/path-adaptations.txt',a.path+'\n');
 return {loader:'ts',contents:s};
});}});
