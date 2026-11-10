// 체험판 HTTP. loopback 에만 열고, 체험판 전용 접속 코드(Bearer)로만 API 를 연다. 운영 서버 API 와 경로·인증을 공유하지 않는다.
import { timingSafeEqual } from "node:crypto";
import type { HindsightConfig } from "../shared/work-types.ts";
import { WorkError, type WorkService } from "./work.ts";

export interface WorkServer { url: string; port: number; stop(): Promise<void> }

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function body<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > 64_000) throw new WorkError(413, "요청이 너무 큽니다");
  try { return (text ? JSON.parse(text) : {}) as T; } catch { throw new WorkError(400, "JSON 형식이 아닙니다"); }
}

export async function startWorkServer(opts: { service: WorkService; accessCode: string; port: number; hostname?: "127.0.0.1" }): Promise<WorkServer> {
  const { service, accessCode } = opts;
  const page = (await import("./work-web-index.ts")).default;
  const api = async (req: Request, url: URL): Promise<Response> => {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || !same(auth.slice(7), accessCode)) return fail(401, "체험판 접속 코드가 필요합니다");
    const p = url.pathname, m = req.method;
    let match: RegExpMatchArray | null;
    if (m === "GET" && p === "/api/state") return json(service.state());
    if (m === "GET" && (match = p.match(/^\/api\/tasks\/([\w-]+)$/))) return json(service.detail(match[1]!));
    if (m === "POST" && p === "/api/tasks") {
      const b = await body<{ title: string; projectId?: string | null; goalId?: string | null; criteria?: string; roleId?: string | null; model?: string | null; dependsOn?: string | null; instruction?: string | null; clientId?: string | null }>(req);
      return json(service.createTask({ title: b.title, projectId: b.projectId ?? null, goalId: b.goalId ?? null, criteria: b.criteria, roleId: b.roleId ?? null, model: b.model ?? null, dependsOn: b.dependsOn ?? null, instruction: b.instruction ?? null, clientId: b.clientId ?? null }), 201);
    }
    if (m === "POST" && (match = p.match(/^\/api\/tasks\/([\w-]+)\/messages$/))) {
      const b = await body<{ clientId?: string; text: string }>(req);
      return json(service.send(match[1]!, { clientId: b.clientId ?? null, text: b.text }), 201);
    }
    if (m === "POST" && (match = p.match(/^\/api\/tasks\/([\w-]+)\/role$/))) return json(service.setRole(match[1]!, (await body<{ roleId: string }>(req)).roleId));
    if (m === "POST" && (match = p.match(/^\/api\/tasks\/([\w-]+)\/model$/))) return json(service.setModel(match[1]!, (await body<{ model: string }>(req)).model));
    if (m === "POST" && (match = p.match(/^\/api\/tasks\/([\w-]+)\/complete$/))) return json(service.complete(match[1]!));
    if (m === "POST" && (match = p.match(/^\/api\/tasks\/([\w-]+)\/resume$/))) return json(service.resume(match[1]!, (await body<{ text?: string }>(req)).text ?? null));
    if (m === "POST" && (match = p.match(/^\/api\/decisions\/([\w-]+)\/answer$/))) return json(service.answer(match[1]!, await body<{ operationId: string; optionKey: string }>(req)));
    if (m === "GET" && (match = p.match(/^\/api\/files\/([\w-]+)$/))) return json(service.file(match[1]!));
    if (m === "PUT" && p === "/api/hindsight/config") return json(service.setHindsight(await body<HindsightConfig>(req)));
    if (m === "POST" && (match = p.match(/^\/api\/hindsight\/records\/([\w-]+)\/retry$/))) return json(await service.retryRecord(match[1]!));
    return fail(404, "없는 경로입니다");
  };
  const server = Bun.serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port,
    development: false,
    routes: { "/": page },
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") return json({ ok: true, trial: true, instanceId: service.instanceId });
      if (!url.pathname.startsWith("/api/")) return fail(404, "없는 경로입니다");
      try { return await api(req, url); }
      catch (e) {
        if (e instanceof WorkError) return fail(e.status, e.message);
        console.error(e);
        return fail(500, "서버 오류");
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port!, stop: async () => { await server.stop(true); } };
}
