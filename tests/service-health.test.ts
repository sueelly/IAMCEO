import { afterEach, expect, test } from "bun:test";
import { watchDaemonHealth } from "../server/service-health.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 4_000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
};

test("살아 있어도 HTTP에 응답하지 않는 자식은 연속 실패 후 한 번만 재시작 요청한다", async () => {
  let requests = 0, restarts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { requests++; return new Promise<Response>(() => {}); } });
  cleanup.push(() => server.stop(true));
  const stop = watchDaemonHealth({ url: `${server.url}api/health`, graceMs: 30, intervalMs: 10, timeoutMs: 15, failureLimit: 3,
    onUnhealthy: () => { restarts++; } });
  cleanup.push(stop);
  await Bun.sleep(15);
  expect(requests).toBe(0);
  await waitFor(() => restarts === 1);
  await Bun.sleep(60);
  expect(restarts).toBe(1);
  expect(requests).toBe(3);
});

test("정상 응답은 실패 횟수를 초기화하고 종료한 감시는 재시작하지 않는다", async () => {
  let requests = 0, restarts = 0;
  let stop = () => {};
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    requests++;
    if (requests === 5) queueMicrotask(() => stop());
    return Response.json({ ok: requests === 3 });
  } });
  cleanup.push(() => server.stop(true));
  stop = watchDaemonHealth({ url: `${server.url}api/health`, graceMs: 0, intervalMs: 30, timeoutMs: 500, failureLimit: 3,
    onUnhealthy: () => { restarts++; } });
  cleanup.push(stop);
  await waitFor(() => requests >= 5);
  expect(restarts).toBe(0);
  stop();
  await Bun.sleep(90);
  expect(restarts).toBe(0);
  expect(requests).toBe(5);
});

test("수 초간의 일시적인 DB 부하는 실패로 세어 새 요청을 겹치지 않는다", async () => {
  let requests = 0, restarts = 0;
  let replied!: () => void;
  const firstReply = new Promise<void>(resolve => { replied = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => {
    requests++;
    await Bun.sleep(3_000);
    replied();
    return Response.json({ ok: true });
  } });
  cleanup.push(() => server.stop(true));
  const stop = watchDaemonHealth({ url: `${server.url}api/health`, graceMs: 0, intervalMs: 10, onUnhealthy: () => { restarts++; } });
  cleanup.push(stop);
  await firstReply;
  stop();
  expect(requests).toBe(1);
  expect(restarts).toBe(0);
}, 10_000);
