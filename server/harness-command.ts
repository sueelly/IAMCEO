// 실행 증거용으로 이해할 수 있는 셸의 작은 부분만 받는다.
// 권한 훅의 탐색용 파서와 달리, 모르는 문법을 건너뛰어 통과시키지 않는다.
import { isAbsolute, resolve } from 'node:path';
type Command = { words: string[]; sep: string };
function parse(src: string): Command[] | null {
  const out: Command[]=[];
  let words:string[]=[], word:string|null=null, quote='', i=0;
  const endWord=()=>{if(word!==null){words.push(word);word=null;}};
  const end=(sep:string)=>{endWord();if(words.length)out.push({words,sep});else if(sep && sep!==';')return false;words=[];return true;};
  while(i<src.length){
    const c=src[i++]!;
    if(quote){
      if(c===quote){quote='';continue;}
      if(quote==='"' && (c==='$'||c==='`'))return null;
      if(quote==='"' && c==='\\' && '"\\$`\n'.includes(src[i]??'\0')){const n=src[i++];if(n!=='\n')word+=n;continue;}
      word+=c;continue;
    }
    if(c==='"'||c==="'"){quote=c;word??='';continue;}
    if(c==='\\'){if(i===src.length)return null;const n=src[i++]!;if(n!=='\n')word=(word??'')+n;continue;}
    if(c==='#' && word===null){while(i<src.length && src[i]!=='\n')i++;continue;}
    if(c===' '||c==='\t'){endWord();continue;}
    if(c==='\n'||c===';'||c==='&'||c==='|'){
      const sep=(c==='&'||c==='|')&&src[i]===c?c+src[i++]:c==='\n'?';':c;
      if(!end(sep))return null;continue;
    }
    // 2>&1 등 출력 스트림 결합만 허용. 입력 변경·치환·제어문·확장은 미확인이다.
    if(c==='>' && (word===null || /^[12]$/.test(word)) && src[i]==='&' && /^[12]$/.test(src[i+1]??'') && (!src[i+2]||/[\s;&|]/.test(src[i+2]!))){word=null;i+=2;continue;}
    if(/[<>$`(){}!*?\[\]~]/.test(c))return null;
    word=(word??'')+c;
  }
  if(quote)return null;
  end('');
  if(out.some(c=>['if','then','fi','else','for','while','until','case','esac','function','!','eval','source','.','alias','unalias','trap','exec','return','exit'].includes(c.words[0]!)))return null;
  // 명시적인 셸 하나만 벗긴다. 나머지 옵션과 셸 상태는 추측하지 않는다.
  if(out.length===1 && ['', ';'].includes(out[0]!.sep) && /^(?:\/bin\/)?(?:bash|zsh|sh)$/.test(out[0]!.words[0]!) && out[0]!.words.length===3 && ['-c','-lc'].includes(out[0]!.words[1]!))return parse(out[0]!.words[2]!);
  return out;
}
const assign=/^[A-Za-z_][A-Za-z0-9_]*=/;
function executable(words:string[]){let i=0;while(assign.test(words[i]??''))i++;return words.slice(i);}
function sequence(src:string,base:string|null): {commands:(Command & {cwd:string|null})[]; pipefail:boolean}|null {
  const chain=parse(src);if(!chain?.length)return null;
  const commands:(Command & {cwd:string|null})[]=[];
  let cwd=base,pipefail=false;
  for(const c of chain){
    const w=executable(c.words);
    if(w[0]==='cd'){
      if(w.length!==2 || c.sep!=='&&' || !w[1] || (!isAbsolute(w[1])&&!cwd))return null;
      cwd=resolve(cwd??'/',w[1]);continue;
    }
    if(w[0]==='set'){
      if(commands.length || w.join(' ')!=='set -o pipefail' || ![';','&&'].includes(c.sep))return null;
      pipefail=true;continue;
    }
    if(!w.length)return null;
    commands.push({...c,words:w,cwd});
  }
  return {commands,pipefail};
}

/** 인자 전체·명령을 실행한 위치·종료 의미를 함께 대조. 불명확한 셸은 통과시키지 않는다. */
export function commandProof(executed:string,want:string,actualCwd:string|null=null,wantedCwd:string|null=actualCwd):'ok'|'absent'|'masked'{
  const actual=sequence(executed,actualCwd),expected=sequence(want,wantedCwd);
  if(!actual || !expected?.commands.length)return 'absent';
  const a=actual.commands,w=expected.commands;
  // 앞의 다른 실행이 환경/셸 상태를 바꾸었을 가능성은 추측하지 않는다.
  if(a.length<w.length)return 'absent';
  for(let i=0;i<w.length;i++){
    const x=a[i]!,y=w[i]!;
    if(x.cwd!==y.cwd || x.words.length!==y.words.length || !y.words.every((v,j)=>v===x.words[j]))return 'absent';
    if(i<w.length-1 && x.sep!==y.sep)return 'absent';
  }
  for(let i=0;i<a.length;i++){
    const sep=a[i]!.sep;
    if(i===a.length-1 ? sep===''||sep===';' : sep==='&&'||(sep==='|'&&actual.pipefail))continue;
    return 'masked';
  }
  return 'ok';
}
