import { expect, test } from "bun:test";
import type { ProjectProgressUpdate, ProjectState } from "../shared/types";
import { applyToProject } from "../web/src/lib/store";

test("진행 이벤트는 현재 프로젝트의 최근 30건을 스냅샷과 같은 순서로 유지한다", () => {
  let state = { project: { id: "p" } } as ProjectState;
  const row = (n: number): ProjectProgressUpdate => ({
    id: String(n).padStart(2, "0"), at: n === 0 ? "2025-01-01" : "2026-01-01",
    projectId: "p", memberId: "m", taskId: null, who: "직원", title: "검수", body: "",
  });
  for (let n = 32; n >= 0; n--) state = applyToProject(state, { type: "progressUpdate", update: row(n) });
  state = applyToProject(state, { type: "progressUpdate", update: row(32) });
  expect(state.progressUpdates?.map(item => item.id)).toEqual(Array.from({ length: 30 }, (_, i) => row(32 - i).id));
  expect(applyToProject(state, { type: "progressUpdate", update: { ...row(50), projectId: "other" } })).toBe(state);
});
