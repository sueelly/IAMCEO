import type { SendMessageReq } from "./types.ts";

// Match the whole utterance. A request such as "다 끝났으면 배포해" must still reach a person.
export function isOwnerStatusQuery(text: string): boolean {
  const value = text.trim().replace(/[.?!？。]+$/u, "").replace(/\s+/gu, " ").replace(/^(?:지금|현재) /u, "");
  const overview = /^(?:(?:업무|작업|프로젝트) )?(?:진행\s*(?:상황|상태)|현황)(?:을|이|은)?(?: (?:좀 )?(?:알려\s*줘(?:요)?|보여\s*줘(?:요)?|어때(?:요)?))?$/u;
  const completion = /^(?:(?:다|전부|모두) )?(?:끝났(?:어|나|나요|니|습니까)|완료됐(?:어|나요|니)|끝났는지 확인해\s*줘(?:요)?|끝난 거지)$/u;
  const progress = /^어디까지 (?:됐|진행됐|왔)(?:어|나요|니)$/u;
  return overview.test(value) || completion.test(value) || progress.test(value) || /^남은 (?:거|일|업무)(?:가)? 없(?:어|지|나요)$/u.test(value);
}

/** A read receipt can be produced locally only when the original calls for no employee or execution. */
export function canAnswerOwnerStatus(req: SendMessageReq, isHq: boolean): boolean {
  return !isHq && req.intent === "execute" && !req.targetMemberId && !req.attachmentIds?.length &&
    !req.contract && !req.recipientRole && !req.newTaskTitle?.trim() && isOwnerStatusQuery(req.text);
}
