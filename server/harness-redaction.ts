// 실행 대조는 원래 인자로 메모리에서만 한다. 보관/조회에는 공개용 문자열만 넘긴다.
import { redactSensitive } from './integrations/dev-memory.ts';
const name = String.raw`[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|credential|authorization|접속코드|비밀번호)[A-Za-z0-9_.-]*`;
// 여러 quoted 조각/escaped 낱말도 한 값으로 취급한다. 짧은 실험용 비밀도 가린다.
const word = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s'"\\;&|])+`;
const assignments = new RegExp(String.raw`\b(${name}\s*[:=]\s*)${word}`, 'gi');
const flags = new RegExp(String.raw`(--${name}(?:=|\s+))${word}`, 'gi');
const jsonValues = new RegExp(String.raw`("${name}"\s*:\s*)"(?:\\.|[^"\\])*"`, 'gi');
export function redactHarnessText(text:string):string {
  let value=text
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
