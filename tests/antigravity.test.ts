import { testTempDir } from "./fixtures/test-run-dirs";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  antigravityDraft, antigravityExactComposer, antigravityFolderTrust, antigravityMemberHome, antigravityTranscriptPath,
  discoverAntigravityConversation, prepareAntigravityHome, readAntigravityContext,
} from "../server/runner/antigravity.ts";
import { providerLaunch, isProviderArgv } from "../server/runner/providers.ts";
import { readDeliveryEvidence } from "../server/runner/delivery-evidence.ts";
import { codexBindingMarker } from "../server/runner/core-context.ts";
import { ModelCatalogReader } from "../server/models.ts";
import { DEFAULT_RANKS, memberConfig } from "../shared/types.ts";
import type { RunnerMember, StartOpts } from "../server/runner/types.ts";

// Screens below were captured from agy 1.5.3 on 2026-11-09 (trailing spaces trimmed).
const RULE = "─".repeat(80);
const idle = (draft = "") => `Antigravity CLI 1.5.3\n\n${RULE}\n> ${draft}\n${RULE}\n? for shortcuts                                   Gemini 4 Argon · medium\n`;
const working = `Thinking...\n\n${RULE}\n> \n${RULE}\nesc to cancel\n`;
// Real agy 1.5.3 layout: blank line between blocks, model footer right-aligned at the bottom.
const trustDialog = (cwd: string) => `Accessing workspace:\n\n${cwd}\n\nDo you trust the contents of this project?\n\nAntigravity CLI requires permission to read, edit, and execute files here.\n\n> Yes, I trust this folder\n  No, exit\n\n  ↑/↓ Navigate · enter Confirm\n${" ".repeat(120)}Gemini 3.8 Flash · low\n`;

const CONV = "4414bdf0-180a-409b-a991-7122de6085a8";
const OTHER = "0d6c5a1e-2b3f-4c4d-9e8f-001122334455";
const dir = () => testTempDir("iamceo-agy-test-");
const member = (extra: Partial<RunnerMember> = {}): RunnerMember => ({ id: "member-agy", sessionGeneration: 1, projectId: "p", cli: "antigravity", handle: "g", name: "Gemini", cwd: "/tmp",
  sessionId: null, paneId: null, model: null, effort: null, subagentModel: null, permissionMode: "default", kind: "worker", origin: "managed", parallel: false, ...extra } as RunnerMember);
function opts(root: string): StartOpts {
  const o: StartOpts = { systemPromptFile: join(root, "rules.md"), mcpConfigFile: join(root, "mcp.json"), resume: false, projectName: "Test" };
  writeFileSync(o.systemPromptFile, "IAMCEO rules for this member");
  writeFileSync(o.mcpConfigFile, JSON.stringify({ mcpServers: { iamceo: { command: "/bin/echo", args: ["bridge"], env: { IAMCEO_TOKEN: "secret", IAMCEO_URL: "http://localhost:1" } } } }));
  return o;
}
const userInput = (text: string, at: string, step = 0) => ({ step_index: step, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at,
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-09T16:07:08+09:00.\n</ADDITIONAL_METADATA>` });
const model = (input: number, cache = 0, step = 1) => ({ step_index: step, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-09T07:07:09Z", input_tokens: input, cache_read_tokens: cache, output_tokens: 87, content: "ok" });
function transcript(home: string, id: string, rows: unknown[]): string {
  const path = antigravityTranscriptPath(home, id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row) + "\n").join(""));
  return path;
}

describe("Antigravity member home", () => {
  test("writes rules, MCP bridge and settings privately; copies the owner's choices read-only", () => {
    const root = dir(), user = join(root, "user"), home = antigravityMemberHome(join(root, "agy"), "member-agy");
    mkdirSync(join(user, "config"), { recursive: true });
    mkdirSync(join(user, "antigravity-cli", "cache"), { recursive: true });
    writeFileSync(join(user, "GEMINI.md"), "Owner rule");
    writeFileSync(join(user, "config", "mcp_config.json"), JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" }, iamceo: { command: "evil" } } }));
    writeFileSync(join(user, "antigravity-cli", "settings.json"), JSON.stringify({ colorScheme: "dark", model: "should-not-copy", permissions: { allow: ["*"] }, trustedWorkspaces: ["/owner"] }));
    const onboarding = JSON.stringify({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true });
    writeFileSync(join(user, "antigravity-cli", "cache", "onboarding.json"), onboarding);
    const before = readFileSync(join(user, "antigravity-cli", "settings.json"), "utf8");
    prepareAntigravityHome({ home, systemPrompt: "IAMCEO rules", bridge: { command: "/bin/echo", args: ["b"], env: { IAMCEO_TOKEN: "t" } }, userRoot: user });
    expect(readFileSync(join(home, "GEMINI.md"), "utf8")).toContain("IAMCEO rules");
    expect(readFileSync(join(home, "GEMINI.md"), "utf8")).toContain("Owner rule");
    const mcp = JSON.parse(readFileSync(join(home, "config", "mcp_config.json"), "utf8"));
    expect(mcp.mcpServers.notes.command).toBe("notes-mcp");
    expect(mcp.mcpServers.iamceo).toEqual({ command: "/bin/echo", args: ["b"], env: { IAMCEO_TOKEN: "t" } });
    const settings = JSON.parse(readFileSync(join(home, "antigravity-cli", "settings.json"), "utf8"));
    expect(settings).toMatchObject({ colorScheme: "dark", showFeedbackSurvey: false, trustedWorkspaces: ["/owner"] });
    expect(settings.model).toBeUndefined();
    expect(settings.permissions).toBeUndefined();
    expect(JSON.parse(readFileSync(join(home, "antigravity-cli", "cache", "onboarding.json"), "utf8"))).toEqual(JSON.parse(onboarding));
    for (const file of ["GEMINI.md", "config/mcp_config.json", "antigravity-cli/settings.json"]) expect(statSync(join(home, file)).mode & 0o077).toBe(0);
    expect(readFileSync(join(user, "antigravity-cli", "settings.json"), "utf8")).toBe(before);
  });
  test("never seeds onboarding the owner has not finished (Terms consent stays with the owner)", () => {
    const root = dir(), user = join(root, "user"), home = join(root, "home");
    mkdirSync(join(user, "antigravity-cli", "cache"), { recursive: true });
    writeFileSync(join(user, "antigravity-cli", "cache", "onboarding.json"), JSON.stringify({ onboardingComplete: false }));
    prepareAntigravityHome({ home, systemPrompt: "r", bridge: { command: "c", args: [], env: {} }, userRoot: user });
    expect(existsSync(join(home, "antigravity-cli", "cache", "onboarding.json"))).toBe(false);
  });
  test("rejects member ids that could leave the root", () => {
    expect(() => antigravityMemberHome("/root", "../x")).toThrow();
    expect(() => antigravityMemberHome("relative", "m")).toThrow();
  });
});

describe("Antigravity launch", () => {
  test("own gemini_dir, MCP allowed for the session, no auto-update, resume by conversation id", () => {
    const root = dir(), o = opts(root);
    const bins = { antigravityBin: "/fake/agy", antigravityRoot: join(root, "agy"), antigravityUserRoot: join(root, "nouser"), contextHome: join(root, "ctx") };
    const launch = providerLaunch(member({ model: "gemini-4-argon-high" }), o, bins);
    expect(launch.argv[0]).toBe("/fake/agy");
    expect(launch.argv).toContain(`--gemini_dir=${join(root, "agy", "member-agy")}`);
    expect(launch.argv.slice(launch.argv.indexOf("--model"), launch.argv.indexOf("--model") + 2)).toEqual(["--model", "gemini-4-argon-high"]);
    expect(launch.argv).not.toContain("--conversation");
    const settings = JSON.parse(launch.argv[launch.argv.indexOf("--settings") + 1]!);
    expect(settings.permissions.allow).toEqual(["mcp(iamceo/*)"]);
    expect(settings.statusLine.command).toContain("context-only");
    expect(launch.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
    expect(launch.sessionId).toBeNull();
    expect(readFileSync(join(root, "agy", "member-agy", "GEMINI.md"), "utf8")).toContain("IAMCEO rules for this member");
    expect(JSON.stringify(launch.argv)).not.toContain("secret");
    const resumed = providerLaunch(member({ sessionId: CONV }), { ...o, resume: true }, bins);
    expect(resumed.argv.slice(resumed.argv.indexOf("--conversation"), resumed.argv.indexOf("--conversation") + 2)).toEqual(["--conversation", CONV]);
    expect(resumed.sessionId).toBe(CONV);
    expect(() => providerLaunch(member(), { ...o, resume: true }, bins)).toThrow();
    expect(providerLaunch(member(), o, { ...bins }).argv).not.toContain("--dangerously-skip-permissions");
    expect(providerLaunch(member({ permissionMode: "bypassPermissions" }), o, bins).argv).toContain("--dangerously-skip-permissions");
    expect(isProviderArgv(launch.argv, "antigravity", "/fake/agy")).toBe(true);
    expect(isProviderArgv(["/usr/local/bin/agy"], "antigravity")).toBe(true);
    expect(isProviderArgv(["/usr/local/bin/agy"], "codex")).toBe(false);
  });
  test("refuses to launch without an IAMCEO-owned root", () => {
    const root = dir();
    expect(() => providerLaunch(member(), opts(root), { antigravityBin: "/fake/agy" })).toThrow();
  });
  test("member config ignores Claude/Codex rank defaults", () => {
    expect(memberConfig({ kind: "worker", cli: "antigravity", modelOverride: null, effortOverride: "high" }, DEFAULT_RANKS)).toEqual({ model: null, effort: null });
    expect(memberConfig({ kind: "worker", cli: "antigravity", modelOverride: "gemini-3.8-flash-low", effortOverride: null }, DEFAULT_RANKS).model).toBe("gemini-3.8-flash-low");
  });
});

describe("Antigravity screens", () => {
  test("composer: empty, draft, working and unknown layouts", () => {
    expect(antigravityDraft(idle())).toBe("");
    expect(antigravityDraft(idle("half typed"))).toBe("half typed");
    expect(antigravityExactComposer(idle("abc"))).toBe("abc");
    expect(antigravityExactComposer(`${RULE}\n> line one\n  line two\n${RULE}\n? for shortcuts\n`)).toBeNull();
    expect(antigravityDraft(working)).toBe("");
    expect(antigravityDraft("no composer here")).toBeNull();
    expect(antigravityDraft(`${RULE}\n> x\n${RULE}\nsomething unexpected\n`)).toBeNull();
  });
  test("folder trust dialog for the exact cwd only", () => {
    const cwd = "/Users/me/project";
    const found = antigravityFolderTrust(trustDialog(cwd), cwd);
    expect(found?.selected).toBe(0);
    expect(found?.prompt.options.map((o) => o.label)).toEqual(["Yes, I trust this folder", "No, exit"]);
    expect(found?.prompt.options[1]?.reject).toBe(true);
    expect(antigravityFolderTrust(trustDialog(cwd), "/Users/me/other")).toBeNull();
    expect(antigravityFolderTrust(idle(), cwd)).toBeNull();
  });
});

describe("Antigravity transcripts", () => {
  const nonce = "a".repeat(32);
  test("binds the one conversation whose user input carries the marker after launch", () => {
    const home = dir(), since = "2026-11-09T07:07:07.500Z";
    transcript(home, CONV, [userInput(`${codexBindingMarker(nonce)}\n\nhello #iamceo_abcdefghijklmnopqrstuv`, "2026-11-09T07:07:07Z"), model(7463)]);
    transcript(home, OTHER, [userInput("unrelated", "2026-11-09T07:07:08Z")]);
    expect(discoverAntigravityConversation({ home, nonce, marker: codexBindingMarker(nonce), since })).toEqual({ outcome: "bound", sessionId: CONV });
  });
  test("a marker only in model output or before launch does not bind", () => {
    const home = dir();
    transcript(home, CONV, [userInput("hi", "2026-11-09T07:07:07Z"), { ...model(10), content: codexBindingMarker(nonce) }]);
    transcript(home, OTHER, [userInput(codexBindingMarker(nonce), "2026-11-09T06:00:00Z")]);
    expect(discoverAntigravityConversation({ home, nonce, marker: codexBindingMarker(nonce), since: "2026-11-09T07:00:00Z" }).outcome).toBe("pending");
  });
  test("two candidates are ambiguous, never guessed", () => {
    const home = dir(), text = codexBindingMarker(nonce);
    transcript(home, CONV, [userInput(text, "2026-11-09T07:07:07Z")]);
    transcript(home, OTHER, [userInput(text, "2026-11-09T07:07:08Z")]);
    expect(discoverAntigravityConversation({ home, nonce, marker: text, since: "2026-11-09T07:00:00Z" })).toEqual({ outcome: "ambiguous", sessionId: null });
  });
  test("context tokens come from the latest model step", () => {
    const home = dir();
    const path = transcript(home, CONV, [userInput("a", "2026-11-09T07:07:07Z"), model(100), userInput("b", "2026-11-09T07:08:07Z", 2), model(7463, 500, 3)]);
    expect(readAntigravityContext(home, path)).toBe(7963);
    expect(readAntigravityContext(dir(), path)).toBeNull();
  });
  const marker = "#iamceo_abcdefghijklmnopqrstuv";
  const evidence = (home: string, path: string, extra = {}) => readDeliveryEvidence({ cli: "antigravity", home, path, cwd: "/work", sessionId: CONV, sessionGeneration: 1,
    markers: [{ deliveryId: "d1", marker }], ...extra });
  test("delivery evidence: user input present, absent, and model echo", () => {
    const home = dir();
    const present = transcript(home, CONV, [userInput(`work ${marker}`, "2026-11-09T07:07:07Z"), model(10)]);
    expect(evidence(home, present).evidence).toMatchObject({ source: "antigravity_log", verdict: "present", location: "received_input" });
    expect(evidence(home, present).receivedDeliveryIds).toEqual(["d1"]);
    const home2 = dir();
    const echoed = transcript(home2, CONV, [userInput("other", "2026-11-09T07:07:07Z"), { ...model(10), content: marker }]);
    expect(evidence(home2, echoed).evidence).toMatchObject({ verdict: "absent", complete: true });
    // created_at has whole seconds: a send at .900 of the same second still counts.
    expect(evidence(home, present, { since: "2026-11-09T07:07:07.900Z" }).receivedDeliveryIds).toEqual(["d1"]);
  });
  test("delivery evidence: wrong conversation path and unknown user-shaped records stay unknown", () => {
    const home = dir();
    const path = transcript(home, OTHER, [userInput(marker, "2026-11-09T07:07:07Z")]);
    expect(evidence(home, path).evidence).toMatchObject({ verdict: "unknown", code: "unrecognized_path" });
    const home2 = dir();
    const odd = transcript(home2, CONV, [{ step_index: 0, source: "USER_EXPLICIT", type: "USER_VOICE", content: marker }]);
    expect(evidence(home2, odd).evidence.verdict).toBe("unknown");
  });
});

describe("Antigravity models", () => {
  test("fixed list with effort in the id; no separate effort", () => {
    const reader = new ModelCatalogReader({ userHome: dir() });
    const list = reader.read().antigravity;
    expect(list.models.some((m) => m.value === "gemini-4-argon-medium")).toBe(true);
    expect(reader.efforts("antigravity", "gemini-4-argon-medium")).toEqual([]);
    expect(() => reader.requireModel("antigravity", "opus")).toThrow();
    expect(() => reader.requireEffort("antigravity", null, "high")).toThrow();
  });
});
