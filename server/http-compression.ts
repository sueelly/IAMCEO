/** Compress buffered JSON reads only; streams, attachments, and writes keep their existing transport. */
export async function compressJsonRead(request: Request, response: Response | undefined): Promise<Response | undefined> {
  if (!response || request.method !== "GET" || !response.ok || !response.headers.get("Content-Type")?.includes("application/json")
    || response.headers.has("Content-Encoding")) return response;
  const vary = response.headers.get("Vary");
  if (!vary?.split(",").some(value => value.trim().toLowerCase() === "accept-encoding")) {
    response.headers.set("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  }
  const encodings = new Map((request.headers.get("Accept-Encoding") ?? "").split(",").map(value => {
    const [name, ...parameters] = value.trim().toLowerCase().split(";");
    const quality = parameters.find(p => p.trim().startsWith("q="));
    return [name, quality ? Number(quality.trim().slice(2)) : 1] as const;
  }));
  const quality = encodings.get("gzip") ?? encodings.get("*") ?? 0;
  if (!Number.isFinite(quality) || quality <= 0 || quality > 1) return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  const plain = () => new Response(bytes, { status: response.status, headers });
  if (bytes.byteLength < 2048) return plain();
  const compressed = Bun.gzipSync(bytes, { level: 4 });
  if (compressed.byteLength >= bytes.byteLength) return plain();
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(compressed.byteLength));
  return new Response(compressed, { status: response.status, headers });
}
