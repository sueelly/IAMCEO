/** Read-only live verification. All device paths, expected counts and URLs live in a private config. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

interface VerificationConfig {
  origin: string; home: string; releaseManifest: string; beforeInventory: string;
  expectedCounts: Record<string, number>; outputDir: string; receiptPath: string;
}
const cfg: VerificationConfig = JSON.parse(readFileSync(process.argv[2], "utf8"));
const release = JSON.parse(readFileSync(cfg.releaseManifest, "utf8"));
if (release.kind !== "read-only-snapshot-view" || release.operational_cutover !== false || new URL(cfg.origin).protocol !== "https:") throw new Error("Read-only HTTPS release required");
const code = JSON.parse(readFileSync(join(cfg.home, "config.json"), "utf8")).accessCode;
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const request = (path: string, method = "GET", authenticated = true) => fetch(cfg.origin + path, {
  method, headers: authenticated ? { Authorization: `Bearer ${code}`, "Content-Type": "application/json" } : {},
  ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}), redirect: "error",
});
assert((await request("/api/readiness", "GET", false)).status === 401, "Private readiness must require authentication");
const readyResponse = await request("/api/readiness"); const ready = await readyResponse.json();
assert(readyResponse.status === 200 && ready.ok && ready.daemon.readOnly === true && ready.daemon.buildId === release.build_id, "Wrong read-only application build");
const bootstrap = await (await request("/api/bootstrap")).json();
assert(bootstrap.projects.length === cfg.expectedCounts.projects, "Registered project count differs");
for (const p of bootstrap.projects) {
  const state = await (await request(`/api/projects/${encodeURIComponent(p.id)}/state`)).json();
  assert(state.project.runnerEnabled === false, "Snapshot runner must remain disabled");
  assert((await request(`/api/projects/${encodeURIComponent(p.id)}/messages/page?limit=20`)).status === 200, "Messages unavailable");
}
for (const [method, path] of [["PATCH", `/api/projects/${bootstrap.projects[0].id}`], ["POST", `/api/projects/${bootstrap.projects[0].id}/messages`], ["POST", "/api/auth/rotate"], ["POST", "/agent/join"], ["GET", "/api/folders"]]) {
  const response = await request(path, method); assert(response.status === 409 && (await response.json()).code === "READ_ONLY", "Unsafe request accepted");
}
const db = new Database(join(cfg.home, "iamceo.db"), { readonly: true });
let attachmentCount: number;
try {
  for (const [table, count] of Object.entries(cfg.expectedCounts)) {
    assert(["projects", "members", "messages", "tasks", "decisions", "files", "attachments"].includes(table), "Unexpected count table");
    assert((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n === count, "Snapshot count differs");
  }
  assert(db.query("PRAGMA foreign_key_check").all().length === 0, "Snapshot FK check failed");
  assert((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check === "ok", "Snapshot integrity failed");
  const fence = JSON.parse((db.query("SELECT value FROM settings WHERE key='restoreReconciliation'").get() as { value: string }).value);
  assert(fence.outboundEnabled === false && fence.reconciliationRequired === true, "Snapshot fence changed");
  const attachments = db.query("SELECT id,name,path FROM attachments").all() as { id: string; name: string; path: string }[];
  attachmentCount = attachments.length;
  const a = attachments[0];
  if (a) {
    const path = `/files/${encodeURIComponent(a.id)}/${encodeURIComponent(a.name)}`;
    assert((await request(path, "GET", false)).status === 401, "Attachment must require authentication");
    const response = await request(path); assert(response.status === 200, "Attachment download failed");
    assert(createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex") === hash(a.path), "Served attachment differs");
  }
} finally { db.close(); }

mkdirSync(cfg.outputDir, { recursive: true, mode: 0o700 }); chmodSync(cfg.outputDir, 0o700);
const browser = await chromium.launch(); const browserErrors: string[] = []; const failedRequests: { path: string; status: number }[] = [];
let routesChecked = 0;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on("pageerror", error => browserErrors.push(error.name));
  page.on("response", response => { if (response.status() >= 400) failedRequests.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  await page.goto(cfg.origin); await page.getByPlaceholder("접속 코드").fill(code);
  await page.getByRole("button", { name: "들어가기", exact: true }).click();
  await page.locator(".shell").waitFor();
  for (const p of bootstrap.projects) {
    for (const tab of ["home", "thread", "files"]) {
      await page.goto(`${cfg.origin}/#/p/${encodeURIComponent(p.id)}/${tab}`);
      await page.locator("[data-scroll-root]").waitFor();
      await page.waitForFunction(() => !document.body.textContent?.includes("불러오는 중"));
      assert((await page.locator("body").innerText()).includes(p.name), "Project not displayed"); routesChecked++;
    }
  }
  await page.screenshot({ path: join(cfg.outputDir, "files-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${cfg.origin}/#/p/${encodeURIComponent(bootstrap.projects[0].id)}/thread`);
  await page.locator("[data-scroll-root]").waitFor();
  await page.waitForFunction(() => !document.body.textContent?.includes("불러오는 중") && document.body.textContent?.includes("서버 연결됨"));
  await page.screenshot({ path: join(cfg.outputDir, "thread-mobile.png"), fullPage: true });
  writeFileSync(join(cfg.outputDir, "browser-diagnostics.json"), JSON.stringify({ browserErrors, failedRequests }, null, 2), { mode: 0o600 });
  assert(browserErrors.length === 0 && failedRequests.length === 0, "Browser errors or refused read requests observed");
  await context.close();
} finally { await browser.close(); }
const inventory: Record<string, string> = JSON.parse(readFileSync(cfg.beforeInventory, "utf8"));
for (const [path, expected] of Object.entries(inventory)) assert(hash(join(cfg.home, path)) === expected, "Snapshot file changed during viewing");
const receipt = { kind: "initial-read-only-view-validation", verified: true, at: new Date().toISOString(), origin: cfg.origin,
  source_sha: release.source_sha, build_id: release.build_id, snapshot_id: release.snapshot_id, supported_schema: ready.schema.supportedVersion,
  counts: cfg.expectedCounts, snapshot_files_hash_unchanged: Object.keys(inventory).length, attachments_preserved: attachmentCount,
  auth_without_credential: 401, blocked_mutations: 409, desktop_routes_checked: routesChecked, mobile_screen_checked: true,
  browser_errors: browserErrors, failed_read_requests: failedRequests, tls_verification: "default_trust_and_hostname", verifying_device: "server_host",
  another_device_access_tested: false, outbound_enabled: false, workers_started: 0, operational_cutover: false };
writeFileSync(cfg.receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }); chmodSync(cfg.receiptPath, 0o600);
console.log(JSON.stringify(receipt));
