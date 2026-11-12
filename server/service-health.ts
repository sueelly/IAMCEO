/** Run in the supervisor: a stalled daemon cannot execute its own watchdog timer. */
export function watchDaemonHealth(options: {
  url: string;
  onUnhealthy: () => void;
  graceMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
  failureLimit?: number;
}): () => void {
  let stopped = false;
  let failures = 0;
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const stop = () => { stopped = true; clearTimeout(timer); request?.abort(); };
  const probe = async () => {
    if (stopped) return;
    const controller = request = new AbortController();
    const deadline = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
    let healthy = false;
    try {
      const response = await fetch(options.url, { signal: controller.signal, redirect: "error" });
      healthy = response.ok && (await response.json() as { ok?: boolean }).ok === true;
    } catch { /* A hung event loop, connection failure and invalid health response are all failures. */ }
    finally { clearTimeout(deadline); request = undefined; }
    if (stopped) return;
    failures = healthy ? 0 : failures + 1;
    if (failures >= (options.failureLimit ?? 3)) {
      stop();
      options.onUnhealthy();
      return;
    }
    timer = setTimeout(() => { void probe(); }, options.intervalMs ?? 10_000);
  };
  timer = setTimeout(() => { void probe(); }, options.graceMs ?? 30_000);
  return stop;
}
