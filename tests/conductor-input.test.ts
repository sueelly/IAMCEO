import { expect, test } from "bun:test";
import { selectConductorInputs } from "../server/conductor-input.ts";
import type { Delivery } from "../shared/types.ts";

const delivery = (id: string, kind: Delivery["kind"]): Delivery => ({ id, kind, wake: true, text: id, taskId: id } as Delivery);

test("밀린 보고가 있어도 대표 입력과 개입을 먼저 받고 한 턴에 세 건을 넘기지 않는다", () => {
  const reports = Array.from({ length: 30 }, (_, i) => delivery(`report-${i}`, "report"));
  const owner = delivery("owner", "user_message"), intervention = delivery("blocked", "system");
  const selected = selectConductorInputs([...reports, intervention, owner], id => id === "blocked");
  expect(selected.map(d => d.id)).toEqual(["owner", "blocked", "report-0"]);
  expect(reports).toHaveLength(30);
});

test("새 질문이 계속 와도 오래된 보고에 처리 기회를 남긴다", () => {
  const old = delivery("old", "report");
  const questions = Array.from({ length: 4 }, (_, i) => delivery(`question-${i}`, "user_message"));
  expect(selectConductorInputs([old, ...questions], () => false).map(d => d.id)).toEqual(["question-0", "question-1", "old"]);
});

test("일반 대표 입력보다 뒤에 온 긴급 입력도 현재 묶음에 포함한다", () => {
  const old = delivery("old", "report");
  const normal = [delivery("a", "user_message"), delivery("b", "user_message")];
  const urgent = { ...delivery("urgent", "user_message"), urgent: true };
  expect(selectConductorInputs([old, ...normal, urgent], () => false).map(d => d.id)).toEqual(["urgent", "a", "old"]);
});
