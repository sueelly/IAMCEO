import { expect, test } from "bun:test";
import { readOwnerContract } from "../server/owner-text-contract.ts";
import { isOwnerStatusQuery } from "../shared/owner-status-query.ts";

test("단일 현황 질문만 인식하고 이어지는 지시·조건·특정 대상은 보존한다", () => {
  for (const text of ["지금 다 끝났어?", "어디까지 됐어?", "진행 상황 알려줘", "현재 업무 현황을 보여줘.", "남은 거 없지?", "다 끝났는지 확인해줘"])
    expect(isOwnerStatusQuery(text), text).toBe(true);
  for (const text of ["다 끝났으면 배포해", "어디까지 됐어? 그리고 배포해.", "인물 화면은 다 끝났어?", "상태창을 구현해", "> 진행 상황 알려줘"])
    expect(isOwnerStatusQuery(text), text).toBe(false);
});

test("대표가 직접 적은 기준을 새 실행에 쓸 때 의미와 항목을 보존한다", () => {
  const text = "종류: 구현\n목표: 표지 업로드 복구\n입력: 표지 이미지\n산출물: 저장된 표지\n범위: 표지 화면\n제한조건: 기존 파일 보존\n완료 조건:\n- PNG 재업로드 성공\n- 새로고침 후 표지 유지\n제외 범위: 없음";
  expect(readOwnerContract(text)).toEqual({kind:"coding", goal:"표지 업로드 복구", inputs:["표지 이미지"], outputs:["저장된 표지"],scope:"표지 화면", constraints:["기존 파일 보존"], acceptance:["PNG 재업로드 성공","새로고침 후 표지 유지"], exclusions:[]});
  for (const changed of [text.replace("제외 범위: 없음", ""), text.replace("기존 파일 보존", ""), text+"\n범위: 전체 서비스", text+"\n임의 항목: 배포", text.replace("표지 업로드 복구","가".repeat(601)), text.replace("PNG 재업로드 성공",""),"표지 업로드를 복구해 줘"]) expect(readOwnerContract(changed)).toBeUndefined();
});
