import { z } from "zod";
import { CHECK_KINDS } from "../shared/task-contract.ts";

/** 업무 시작 계약. 업무에 붙고, 다시 주면 새 판이 된다. */
export const contractSchema = z.strictObject({
  main_authority: z.string().trim().min(1).max(1200).optional().describe("이 저장소의 main 통합·일반 푸시를 이미 승인한 대표 원문 또는 프로젝트 규칙의 출처와 적용 범위. 해당 승인이 있는 코딩 업무에서 기록한다. 작업 브랜치까지만 승인된 경우 생략한다."),
  kind: z.enum(["coding", "research", "other"]).describe("coding 코딩 · research 조사 · other 그 밖"),
  goal: z.string().trim().min(1).max(600).describe("원하는 결과 한두 문장"),
  acceptance: z.array(z.string().trim().min(1).max(400)).min(1).max(12).describe("통과·실패로 판단할 합격 기준. 번호가 붙고, 완료 보고의 검사가 이 번호(criterion)를 가리켜야 한다"),
  scope: z.string().trim().max(600).optional().describe("자율로 해도 되는 범위"),
  inputs: z.array(z.string().trim().min(1).max(600)).min(1).max(12).optional().describe("실행에 사용할 입력·원문·자료·전제. 새 실행 전에 명시한다"),
  outputs: z.array(z.string().trim().min(1).max(600)).min(1).max(12).optional().describe("완료 후 전달할 산출물과 위치·형식. 새 실행 전에 명시한다"),
  constraints: z.array(z.string().trim().min(1).max(600)).max(12).optional().describe("실행 중 지킬 제한조건. 없으면 빈 배열로 명시한다"),
  exclusions: z.array(z.string().trim().min(1).max(600)).max(12).optional().describe("이번 업무에서 제외한 범위. 없으면 빈 배열로 명시한다"),
  forbidden: z.array(z.string().trim().min(1).max(300)).max(12).optional().describe("하지 말 것"),
  evidence: z.array(z.string().trim().min(1).max(300)).max(12).optional().describe("완료 보고에 남길 증거"),
  checks: z.array(z.enum(CHECK_KINDS)).max(8).optional().describe("필수 검사 종류. 비우면 coding: behavior·typecheck·regression·real, research: source·fact·unverified, other: 없음"),
}).describe("업무 시작 계약. 새 실행 전 goal·inputs·outputs·scope·constraints·acceptance·exclusions를 명시한다. 미정 계약은 저장할 수 있지만 총괄이 보완하기 전에는 새 실행을 맡기지 않는다. 완료 보고는 필수 검사와 합격 기준별 통과 검사가 있어야 받는다");
