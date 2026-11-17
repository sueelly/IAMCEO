import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/** Own only the subprocesses explicitly started by an isolated server test. */
export function createTestServerScope({ graceMs = 2000 } = {}) {
  const children = new Set<Bun.Subprocess>();
  let stopping: Promise<void> | undefined;

  function spawn<
    const In extends Bun.SpawnOptions.Writable = "ignore",
    const Out extends Bun.SpawnOptions.Readable = "pipe",
    const Err extends Bun.SpawnOptions.Readable = "inherit",
  >(command: string[], options: Bun.SpawnOptions.OptionsObject<In, Out, Err>) {
    if (stopping) throw new Error("Test server scope is stopped");
    const env = options.env;
    if (env?.IAMCEO_TEST !== "1" || !env.IAMCEO_HOME) throw new Error("Explicit isolated test environment required");
    const home = realpathSync(env.IAMCEO_HOME);
    const inside = [realpathSync(tmpdir()), realpathSync("/tmp")].some((root) => {
      const path = relative(root, home);
      return path !== "" && !path.startsWith("..") && !isAbsolute(path);
    });
    if (!inside) throw new Error("Test server home must be a private temporary directory");
    if (command[0] !== process.execPath) throw new Error("Test server scope requires the current Bun executable");
    // The preload removes Bun's exported flag after its native watcher is armed,
    // keeping this policy out of independently owned providers' environment.
    const child = Bun.spawn([command[0], "--no-orphans", "--preload", join(import.meta.dir, "test-server-watchdog-preload.ts"), ...command.slice(1)], options);
    children.add(child as Bun.Subprocess);
    void child.exited.then(() => children.delete(child as Bun.Subprocess));
    return child;
  }

  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      await Promise.all([...children].map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const exited = await Promise.race([
            child.exited.then(() => true),
            new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), graceMs); }),
          ]);
          if (!exited) {
            child.kill("SIGKILL");
            await child.exited;
          }
        } finally { clearTimeout(timeout); }
      }));
    })();
    return stopping;
  }

  return { spawn, stop };
}
