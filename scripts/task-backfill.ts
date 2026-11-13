// 업무가 없던 옛 글 정리(계획·적용·되돌리기). 서버가 쓰는 데이터 홈에서는 돌지 않는다(홈 잠금을 못 잡으면 멈춘다).
// 실제 데이터에 쓰려면 서버를 멈춘 뒤 대표 승인을 받고 따로 돌린다. 기본은 계획만 세우고 아무것도 바꾸지 않는다.
//
//   bun scripts/task-backfill.ts plan  --db <iamceo.db> --project <id> [--out plan.json]
//   bun scripts/task-backfill.ts apply --db <iamceo.db> --plan plan.json
//   bun scripts/task-backfill.ts undo  --db <iamceo.db> --project <id> --batch <tb_...>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Bus } from "../server/bus.ts";
import { openDb } from "../server/db.ts";
import { acquireHomeOwner } from "../server/home-owner.ts";
import { Store } from "../server/store.ts";
import { applyTaskBackfill, planTaskBackfill, undoTaskBackfill, type BackfillPlan } from "../server/task-backfill.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function need(name: string): string {
  const v = arg(name);
  if (!v) throw new Error(`--${name} 이 필요합니다`);
  return v;
}

const command = process.argv[2];
if (!command || !["plan", "apply", "undo"].includes(command)) {
  console.error("쓰는 법: plan|apply|undo --db <iamceo.db> ...");
  process.exit(2);
}
const dbPath = resolve(need("db"));
// 서버가 이 홈을 쓰는 중이면 여기서 멈춘다(실행 중인 서버의 DB 를 몰래 바꾸지 않는다).
const owner = acquireHomeOwner(dirname(dbPath));
try {
  const store = new Store(openDb(dbPath), new Bus());
  if (command === "plan") {
    const plan = planTaskBackfill(store, need("project"));
    const out = arg("out");
    if (out) writeFileSync(out, JSON.stringify(plan, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ projectId: plan.projectId, counts: plan.counts, groups: plan.groups.slice(0, 20).map(g => ({ title: g.title, size: g.size })) }, null, 2));
  } else if (command === "apply") {
    const plan = JSON.parse(readFileSync(need("plan"), "utf8")) as BackfillPlan;
    console.log(JSON.stringify(applyTaskBackfill(store, plan), null, 2));
  } else {
    console.log(JSON.stringify(undoTaskBackfill(store, need("project"), need("batch")), null, 2));
  }
} finally {
  owner.release();
}
