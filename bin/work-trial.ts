#!/usr/bin/env bun
// 업무 중심 로컬 체험판 서버. 운영 IAMCEO(설정·DB·core·세션)를 읽거나 쓰지 않는다.
//   bun bin/work-trial.ts serve --home /private/tmp/icxp-xxxx/data [--port 7882] [--delay 1500]
//   bun bin/work-trial.ts stop --home <같은 홈>
//   bun bin/work-trial.ts info --home <같은 홈>
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { WorkService } from "../server/work.ts";
import { startWorkServer } from "../server/work-http.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2] ?? "serve";
const homeArg = arg("home");
if (!homeArg) { console.error("--home <체험판 데이터 폴더> 가 필요합니다(운영 IAMCEO_HOME 과 다른 새 폴더)"); process.exit(2); }
const home = resolve(homeArg);
if (process.env.IAMCEO_HOME && resolve(process.env.IAMCEO_HOME) === home) { console.error("운영 IAMCEO_HOME 과 같은 폴더는 쓸 수 없습니다"); process.exit(2); }
const pidFile = join(home, "trial.pid"), codeFile = join(home, "access-code"), urlFile = join(home, "url");

function accessCode(): string {
  if (existsSync(codeFile)) return readFileSync(codeFile, "utf8").trim();
  const code = randomBytes(18).toString("base64url");
  writeFileSync(codeFile, code + "\n", { mode: 0o600 });
  chmodSync(codeFile, 0o600);
  return code;
}

if (cmd === "stop") {
  if (!existsSync(pidFile)) { console.log("실행 중인 체험판이 없습니다"); process.exit(0); }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString();
  if (!ps.includes("work-trial.ts")) { console.log(`pid ${pid} 는 체험판 서버가 아닙니다. 그대로 둡니다`); process.exit(1); }
  process.kill(pid, "SIGTERM");
  console.log(`체험판 서버(pid ${pid})에 종료를 보냈습니다`);
  process.exit(0);
}

if (cmd === "info") {
  console.log(`홈: ${home}\n주소: ${existsSync(urlFile) ? readFileSync(urlFile, "utf8").trim() : "(아직 시작 안 함)"}\n접속 코드 파일: ${codeFile}`);
  process.exit(0);
}

if (cmd !== "serve") { console.error(`모르는 명령: ${cmd}`); process.exit(2); }

mkdirSync(home, { recursive: true });
const port = Number(arg("port") ?? 7882);
const delayMs = Number(arg("delay") ?? 1500);
const service = new WorkService({ dbPath: join(home, "work-trial.db"), delayMs });
const code = accessCode();
let server;
try {
  server = await startWorkServer({ service, accessCode: code, port });
} catch (e) {
  console.error(`포트 ${port} 에 열 수 없습니다: ${e instanceof Error ? e.message : e}`);
  service.close();
  process.exit(1);
}
writeFileSync(pidFile, String(process.pid));
writeFileSync(urlFile, server.url);
console.log(`업무 중심 로컬 체험판: ${server.url}`);
console.log(`처음 열 때: ${server.url}/#code=<접속 코드>  (코드는 ${codeFile})`);
console.log(`홈: ${home} · 실행: 테스트 실행기(외부 모델 호출 없음) · 체험 인스턴스 ${service.instanceId}`);

const shutdown = async () => {
  await server.stop();
  await service.settled();
  service.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
