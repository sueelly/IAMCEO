import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "..");

/** Every distributed executable embeds the same production browser build. */
export async function buildApp(options: { outfile: string; target?: string }): Promise<void> {
  const outfile = resolve(root, options.outfile);
  mkdirSync(dirname(outfile), { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve(root, "bin/iamceo.ts")], target: "bun", minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    jsx: { runtime: "automatic", development: false },
    compile: { outfile, ...(options.target ? { target: `bun-${options.target}` as Bun.Build.CompileTarget } : {}) },
  });
  if (!result.success) throw new AggregateError(result.logs, "앱 만들기 실패");
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { outfile: { type: "string", default: "dist/iamceo" }, target: { type: "string" } }, strict: true });
  await buildApp({ outfile: values.outfile!, target: values.target });
}
