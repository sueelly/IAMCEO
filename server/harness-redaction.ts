// 실행 대조는 원래 인자로 메모리에서만 한다. 보관/조회에는 공개용 문자열만 넘긴다.
import { redactSensitive } from './integrations/dev-memory.ts';
const name = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|credential|authorization|접속코드|비밀번호)[A-Za-z0-9_.-]*`;
// 여러 quoted 조각/escaped 낱말도 한 값으로 취급한다. 짧은 실험용 비밀도 가린다.
const word = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s'"\\;&|])+`;
const assignments = new RegExp(String.raw`\b(${name}\s*[:=]\s*)${word}`, 'gi');
const flags = new RegExp(String.raw`(--${name}(?:=|\s+))${word}`, 'gi');
const jsonValues = new RegExp(String.raw`("${name}"\s*:\s*)"(?:\\.|[^"\\])*"`, 'gi');
interface ShellWord { start: number; end: number; value: string }
/** 공개용 범위 찾기 전용. 실행·변수 확장 없이 literal 따옴표 연결과 역슬래시를 푼다. */
function shellWords(text: string): ShellWord[] {
  const words: ShellWord[] = [];
  let i = 0;
  while (i < text.length) {
    if (/[\s;|&()<>]/.test(text[i]!)) { i++; continue; }
    const start = i;
    let value = "", quote = "";
    while (i < text.length) {
      const c = text[i]!;
      if (quote === "'") {
        i++;
        if (c === quote) quote = ""; else value += c;
      } else if (quote === '"') {
        i++;
        if (c === quote) { quote = ""; continue; }
        if (c === "\\" && i < text.length && '"\\$`\n'.includes(text[i]!)) {
          if (text[i] !== "\n") value += text[i];
          i++;
        } else value += c;
      } else {
        if (/[\s;|&()<>]/.test(c)) break;
        i++;
        if (c === "'" || c === '"') quote = c;
        else if (c === "\\" && i < text.length) {
          if (text[i] !== "\n") value += text[i];
          i++;
        } else value += c;
      }
    }
    // 닫히지 않은 따옴표도 남은 전체를 한 값으로 가린다. 의미를 추측해 실행하지 않는다.
    words.push({ start, end: i, value });
  }
  return words;
}
const sensitiveName = new RegExp(`^(?:${name})$`, 'i');
const authenticationHeader = /(?:authorization|x-api-key)\s*:\s*(.*)$/i;
/** 같은 셸 인자가 되는 표기는 같은 범위 전체를 가린다. 원래 텍스트의 나머지 부분은 보존한다. */
function redactShellArguments(text: string): string {
  const words = shellWords(text);
  const ranges: { start: number; end: number }[] = [];
  const hide = (i: number) => { const w = words[i]; if (w) ranges.push({ start: w.start, end: w.end }); };
  words.forEach((word, i) => {
    const v = word.value, eq = v.indexOf('=');
    if (eq > 0 && sensitiveName.test(v.slice(0, eq))) hide(i);
    if (v.startsWith('--')) {
      const key = v.slice(2).split('=')[0]!;
      if (sensitiveName.test(key) || ['user', 'proxy-user', 'oauth2-bearer'].includes(key.toLowerCase())) {
        if (eq >= 0) hide(i); else hide(i + 1);
      }
    }
    if (/^-[uU]/.test(v)) { if (v.length > 2) hide(i); else hide(i + 1); }
    const header = authenticationHeader.exec(v);
    if (header) {
      hide(i);
      // 보통 문장/낱말로 나뉜 헤더도 값의 끝까지 가린다.
      if (!header[1]!.trim()) {
        hide(i + 1);
        if (/^(Bearer|Basic)$/i.test(words[i + 1]?.value ?? '')) hide(i + 2);
      } else if (/^(Bearer|Basic)$/i.test(header[1]!.trim())) hide(i + 1);
    }
    // username-only userinfo도 인증값일 수 있다. 인자 전체를 가려 원문 표기 차이를 남기지 않는다.
    if (/[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(v)) hide(i);
    // 해석하지 않는 ANSI-C/locale quote는 공개 시 보수적으로 전체를 가린다.
    if (/\$['"]/.test(text.slice(word.start, word.end))) hide(i);
    if (['-H', '--header'].includes(v)) {
      const next = words[i + 1];
      if (next && /[$`]/.test(next.value)) hide(i + 1);
    }
  });
  const merged: { start: number; end: number }[] = [];
  for (const r of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  for (const r of merged.reverse()) text = text.slice(0, r.start) + '[가림]' + text.slice(r.end);
  return text;
}

export function redactHarnessText(text:string):string {
  let value=redactShellArguments(text)
    .replace(/(["'])Authorization:\s*[^"'\r\n]*\1/gi, "$1Authorization: [가림]$1")
    .replace(/\bAuthorization:\s*(?:Bearer\s+|Basic\s+)?[^\s'";&|]+/gi,'Authorization: [가림]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[가림]@')
    .replace(jsonValues,'$1"[가림]"')
    .replace(flags,'$1[가림]')
    .replace(assignments,'$1[가림]');
  return redactSensitive(value);
}
/** 기존 데이터의 조회도 같은 가림을 거친다. 원래 객체를 바꾸지 않는다. */
export function publicHarness<T>(value:T):T {
  if(typeof value==='string')return redactHarnessText(value) as T;
  if(Array.isArray(value))return value.map(publicHarness) as T;
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,publicHarness(v)])) as T;
  return value;
}
