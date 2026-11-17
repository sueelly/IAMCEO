// 탭 건수 표시. 폰 탭 칸은 320px 에서 57px 남짓이라 세 자리 건수가 들어가지 않는다.
// 100 이상은 '99+'로 줄여 보이고, 정확한 수는 화면 읽기 프로그램용 글로 남긴다.

export const TAB_COUNT_CAP = 99;

/** 탭 건수 글. shown 화면에 보이는 글 · exact 줄였을 때 읽어 줄 정확한 수(줄이지 않았으면 null) */
export function tabCountText(n: number): { shown: string; exact: string | null } {
  if (n > TAB_COUNT_CAP) return { shown: `${TAB_COUNT_CAP}+`, exact: `${n}건` };
  return { shown: String(n), exact: null };
}
