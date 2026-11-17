/** Snapshot viewing deliberately does not import the orchestrator, runners, daemon or restore lifecycle. */
import { Database } from "bun:sqlite";
import { Bus } from "./bus.ts";
import { VERSION, type Config } from "./config.ts";
import { MIGRATIONS } from "./db.ts";
import { startServer } from "./http.ts";
import type { OrchestratorApi } from "./orchestrator-api.ts";
import { ApiError, Store } from "./store.ts";

function readOnlyPorts(): OrchestratorApi {
  const refuse = async (): Promise<never> => { throw new ApiError(409, "초기 복원본은 읽기 전용입니다", "READ_ONLY"); };
  return {
    createProject: refuse, onProjectPatched: refuse, updateSettings: refuse, patchMemberConfig: refuse,
    startConductor: refuse, sendUserMessage: refuse, answerDecision: refuse, setTodoDone: refuse,
    memberSleep: refuse, memberResume: refuse, memberCompact: refuse, memberInterrupt: refuse,
    memberScreen: refuse, adopt: refuse, listAgentTools: refuse, handleAgentTool: refuse, askWait: refuse,
    async herdrAgents() { return []; },
    async memberNativePrompt() { return { prompt: null, context: null }; },
    async memberApproval() { return null; },
    async herdrInfo() { return { installed: false, running: false, version: null, protocol: null, compatible: false, warning: null }; },
    async runtimeInfo() { return { backend: "core", core: { installed: false, available: false, version: null, detail: "읽기 전용 복원본" },
      providers: { claude: { installed: false }, codex: { installed: false }, antigravity: { installed: false } } }; },
  };
}

export async function startReadOnlyView(config: Config, buildId: string) {
  // No migration, WAL recovery, project initialization, or lifecycle reconciliation is performed here.
  const db = new Database(config.dbPath, { readonly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const schema = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (schema !== MIGRATIONS.length) throw new Error("Snapshot schema is incompatible with this viewer");
    if (!db.query("SELECT 1 FROM projects WHERE id='hq'").get()) throw new Error("Snapshot HQ is missing");
    const bus = new Bus(); const store = new Store(db, bus, undefined, { readOnly: true });
    const isolated: Config = { ...config, hosts: ["127.0.0.1"], hostsAuto: false,
      claudeBin: "/usr/bin/false", codexBin: "/usr/bin/false", antigravityBin: "/usr/bin/false", coreBin: "/usr/bin/false",
      claudeHome: config.home + "/disabled-provider-homes/claude", codexHome: config.home + "/disabled-provider-homes/codex" };
    const server = await startServer({ config: isolated, bus, store, orch: readOnlyPorts(), readOnly: true,
      detectHosts: () => [], daemon: () => ({ ready: true, version: VERSION, buildId, readOnly: true }) });
    return { server, store, async stop() { await server.stop(); db.close(); } };
  } catch (error) { db.close(); throw error; }
}
