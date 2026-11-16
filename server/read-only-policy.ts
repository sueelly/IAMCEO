/** New API routes are denied until reviewed for side effects. GET alone is not sufficient. */
export function readOnlyRequestAllowed(method: string, path: string): boolean {
  if (["/api/files-session", "/api/realtime-session"].includes(path)) return method === "POST" || method === "DELETE";
  if (method !== "GET" && method !== "HEAD") return false;
  if (path.startsWith("/agent/") || path.startsWith("/pair/")) return false;
  if (!path.startsWith("/api/")) return true; // Static UI, authenticated attachments and event-only /ws.
  return /^\/api\/(?:health|readiness|bootstrap|sync|capabilities|models|runtime|projects\/archived)$/.test(path) ||
    /^\/api\/projects\/[^/]+\/(?:state|messages(?:\/page)?|archive\/(?:state|messages(?:\/page|\/[^/]+)?)|decisions)$/.test(path) ||
    /^\/api\/(?:messages|decisions|members)\/[^/]+$/.test(path) ||
    /^\/api\/files\/[^/]+\/artifact$/.test(path);
}
