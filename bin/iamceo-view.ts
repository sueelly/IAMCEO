import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Config } from "../server/config.ts";
import { startReadOnlyView } from "../server/read-only-view.ts";

const home = process.env.IAMCEO_VIEW_HOME;
const port = Number(process.env.IAMCEO_VIEW_PORT ?? "47879");
if (!home || !isAbsolute(home) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Absolute IAMCEO_VIEW_HOME and valid IAMCEO_VIEW_PORT required");
// Read the existing credential, without changing config, creating directories or taking an owner lock.
const configPath = join(home, "config.json");
const fd = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
let accessCode: string;
try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error("Private snapshot config required");
  accessCode = JSON.parse(readFileSync(fd, "utf8")).accessCode;
  if (typeof accessCode !== "string" || !accessCode || accessCode.includes("\0")) throw new Error("Snapshot access code missing");
} finally { closeSync(fd); }
const config: Config = { home, configPath, dbPath: join(home, "iamceo.db"), uploadsDir: join(home, "uploads"),
  inboxDir: join(home, "inbox"), rolesDir: join(home, "roles"), accessCode, port, hosts: ["127.0.0.1"], hostsAuto: false,
  claudeBin: "/usr/bin/false", herdrSocket: join(home, "disabled.sock") };
const buildId = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
const view = await startReadOnlyView(config, buildId);
console.log(JSON.stringify({ kind: "read-only-snapshot-view", port: view.server.port, buildId, workers: 0 }));
let closing = false;
const stop = async () => { if (closing) return; closing = true; await view.stop(); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
