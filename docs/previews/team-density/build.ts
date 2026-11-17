import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { workflowBucket, workflowCategory, workflowSummary } from "../../../shared/workflow-view";
import type { WorkflowNode } from "../../../shared/workflow";
const [snapshotPath, outputPath] = process.argv.slice(2);
if (!snapshotPath || !outputPath) throw new Error("Usage: bun build.ts PRIVATE_SNAPSHOT PRIVATE_OUTPUT_DIRECTORY");
const root = resolve(import.meta.dir, "../../..");
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const output = resolve(outputPath);
if (output.startsWith(root + "/")) throw new Error("실제 운영 기록은 저장소 밖에 저장합니다");
await mkdir(output, { recursive: true, mode: 0o700 });
const build = await Bun.build({ entrypoints: [join(import.meta.dir, "preview.tsx")], target: "browser", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
if (!build.success) throw new AggregateError(build.logs);
const js = await build.outputs.find(p => p.path.endsWith(".js"))!.text();
const css = (await Promise.all(["web/src/styles/tokens.css", "web/src/styles/glass.css", "docs/previews/team-density/preview.css"].map(p => readFile(join(root, p), "utf8")))).join("\n");
const safe = (s: string) => s.replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
await writeFile(join(output, "index.html"), `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>God of the world · 팀 화면 설계</title><style>${css}</style><body><div id="root"></div><script>window.PREVIEW_DATA=${safe(JSON.stringify(snapshot))}</script><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`, { mode: 0o600 });
const nodes:WorkflowNode[] = snapshot.workflow.nodes;
const taskMap = new Map<string, any>(snapshot.tasks.map((t:any) => [t.id,t]));
const counts = workflowSummary(nodes);
const plain = (s:unknown) => String(s ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
const lines = ["# God of the world 팀 화면 예시", "", "직원별 요약 행과 오른쪽 상세 패널을 추천합니다. 기본 화면에서 팀을 비교하고, 직원이나 숫자를 누르면 해당 업무 전체를 확인합니다.", "",
  `실제 구성을 관측한 시점: ${snapshot.capturedAt} (한국 시간 ${new Intl.DateTimeFormat("ko-KR",{dateStyle:"short",timeStyle:"short",timeZone:"Asia/Seoul"}).format(new Date(snapshot.capturedAt))}). 운영 소스: ${snapshot.sourceSha}.`,
  "실제 직원 이름·업무 제목·관계를 읽기 전용 스냅샷으로 구성했습니다. 현재 실시간 상태가 아니며 이 예시를 열거나 조작해도 운영 배정·지시·승인·중단 상태는 바뀌지 않습니다. 운영 화면에는 아직 이 요약 구조를 적용하지 않았습니다.", "",
  "## 추천 구조", "", "- 직원 한 명을 한 행으로 표시하고 지금, 다음·대기, 확인 필요, 최근 완료를 같은 열에서 비교합니다.",
  "- 실행 중 옆의 ‘외 N’은 같은 상태의 추가 업무입니다. 검토·막힘을 실행 중 수에 합치지 않습니다.",
  "- 막힘과 검토 수를 눌러 해당 목록을 열고 원래 이유와 마지막 보고를 확인합니다. 직원 이름을 누르면 완료를 포함한 모든 담당 업무를 봅니다.",
  "- 위쪽 미배정 숫자를 누르면 미배정 전체를 엽니다. 우클릭 또는 상세의 연결만 보기로 관련 업무를 모읍니다. 전체 보기로 돌아가면 이전 검색·필터를 유지합니다.",
  "- 전체 카드 버튼은 기존처럼 펼친 구조와 비교하기 위한 예시입니다. 휴대폰에서는 짧은 직원 행과 아래에서 열리는 상세 패널을 사용합니다.",
  "- 원래 직원 설정·터미널·승인 조작은 운영 구현에서 직원 상세에 유지하는 제안입니다. 이 예시에는 실제 제어를 연결하지 않았습니다.", "",
  `상단 고유 업무 집계: 전체 ${counts.all}, 확인 필요 ${counts.action}, 실행 중 ${counts.running}, 다음 ${counts.next}, 완료 ${counts.done}, 미배정 ${counts.unassigned}.`,
  `담당별 표시 ${nodes.length}개와 고유 업무 ${counts.all}개는 다른 수입니다. 같은 업무가 여러 직원에게 보이므로 아래 직원별 합계와 상단 합계는 같지 않습니다. 실행 중 업무 표시 수는 세션 수가 아닙니다.`, "",
  "## 직원별 전체 구성", "", "지금과 확인 필요는 일부 겹칩니다. 지금은 화면 위치, 확인 필요는 확인해야 할 상태를 뜻합니다.", "",
  "| 직원 | 전체 | 지금 | 다음·대기 | 확인 필요 | 완료 |", "| --- | ---: | ---: | ---: | ---: | ---: |"];
for (const member of snapshot.members) {
  const ns = nodes.filter(n=>n.memberId===member.id);
  lines.push(`| ${plain(member.name)} | ${ns.length} | ${ns.filter(n=>workflowBucket(n)==="now").length} | ${ns.filter(n=>workflowBucket(n)==="next").length} | ${ns.filter(n=>workflowCategory(n)==="action").length} | ${ns.filter(n=>n.state==="done").length} |`);
}
lines.push("", "## 모든 업무와 관계", "", "아래는 담당별 원래 순서입니다. 같은 업무 ID는 같은 업무이며 부모 ID가 있으면 파생 관계입니다. 확인 필요인 업무를 완료로 바꾸거나 대기열에 새로 등록하지 않습니다.");
for (const member of [...snapshot.members,{id:null,name:"미배정"}]) {
  lines.push("", `### ${member.name}`, "");
  for (const n of nodes.filter(n=>n.memberId===member.id).sort((a,b)=>a.order-b.order)) {
    const t=taskMap.get(n.taskId);
    lines.push(`- [${n.taskId}] **${plain(t?.title)}** — ${n.label}; 위치: ${{now:"지금",next:"다음·대기",done:"완료",unassigned:"미배정"}[workflowBucket(n)]}.`);
    if(t?.parentTaskId) lines.push(`  부모: [${t.parentTaskId}] ${plain(taskMap.get(t.parentTaskId)?.title)}.`);
    if(n.reason) lines.push(`  상태 근거: ${plain(n.reason)}`);
    if(n.lastActivity) lines.push(`  마지막 기록·${n.lastActivity.kind} (${n.lastActivity.at}): ${plain(n.lastActivity.title)}`);
  }
}
lines.push("", "## 파일 열기", "", "```sh", `open '${join(output,"index.html")}'`, `cat '${join(output,"README.md")}'`, "```", "", "HTML은 스타일·스크립트·필요 데이터를 모두 포함합니다. 외부 네트워크 없이 열립니다. 원본 기록과 이 결과물은 Git 밖의 작업 전용 경로에 보관합니다.", "");
await writeFile(join(output,"README.md"),lines.join("\n"),{mode:0o600});
console.log(JSON.stringify({ html: join(output, "index.html"), capturedAt: snapshot.capturedAt, members: snapshot.members.length, nodes: snapshot.workflow.nodes.length }));
