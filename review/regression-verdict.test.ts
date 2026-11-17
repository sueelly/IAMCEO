import{test,expect}from'bun:test';import{compareRegression}from'../scripts/check-regression';
const name='PATCH는 단일 진입점으로 cwd를 확장해 한 번 위임하고 hook/저장을 중복하지 않는다';
const log=(n=1,extra='')=>Array.from({length:n},()=>`(fail) ${name} [1.00ms]`).join('\n')+`\n${n} tests failed:\n`+Array.from({length:n},()=>`(fail) ${name} [1.00ms]`).join('\n')+`\n 588 pass\n ${n} fail\nRan ${588+n} tests across 32 files. [1s]\n`+extra;
test('known execution and repeated summary count once, without hiding a second execution',()=>{expect(compareRegression(log(),1,log(),1).ok).toBe(true);expect(compareRegression(log(),1,log(2),1).ok).toBe(false)});
test('extra unhandled error or exit2 cannot become success under the known name',()=>{expect(compareRegression(log(),1,log(1,'Unhandled error: extra failure'),2).ok).toBe(false);expect(compareRegression(log(),1,log(),2).ok).toBe(false)});
test('new named failure, missing summary and changed totals are rejected',()=>{expect(compareRegression(log(),1,log().replace(name,'새 실패'),1).ok).toBe(false);expect(compareRegression(log(),1,'(fail) '+name,1).ok).toBe(false);expect(compareRegression(log(),1,log().replace(' 1 fail',' 2 fail'),1).ok).toBe(false)});
