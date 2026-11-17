import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { publicHarness } from "./harness-redaction.ts";
import { decodeStoredText, encodeStoredText } from "./stored-text.ts";

export const UNKNOWN_AGENT_RESULT = { text: "이 작업의 결과를 확인할 수 없습니다. 같은 작업은 자동 재실행하지 않습니다", isError: true };
export type AgentReceiptState = "reserved" | "completed";
export type AgentResultKind = "json" | "report-reference-v1";
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === "object" && !Array.isArray(v);

export function canonicalAgentRequest(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => object(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
export const agentRequestHash = (request: string): string => createHash("sha256").update(request).digest("hex");

function fileContent(db: Database, projectId: string, id: unknown): { body: string; html: string | null } | null {
  if (typeof id !== "string") return null;
  const row = db.query<{ project_id: string; body: unknown; html: unknown }, [string]>("SELECT project_id,body,html FROM files WHERE id = ?").get(id);
  if (!row || row.project_id !== projectId) return null;
  return { body: publicHarness(decodeStoredText(row.body)), html: row.html === null ? null : publicHarness(decodeStoredText(row.html)) };
}

/** Retain the response snapshot except for immutable material that has a verified original. */
export function encodeAgentResult(db: Database, projectId: string, tool: string, request: unknown, result: unknown): { kind: AgentResultKind; value: string | Uint8Array } {
  const plain = () => ({ kind: "json" as const, value: encodeStoredText(JSON.stringify(result)) });
  if (tool !== "post" || !object(request) || typeof request.report_id !== "string" || !object(result) || result.isError || typeof result.text !== "string") return plain();
  let report: unknown;
  try { report = JSON.parse(result.text); } catch { return plain(); }
  if (!object(report) || report.sourceMessageId !== request.report_id || !Array.isArray(report.files) || JSON.stringify(report) !== result.text) return plain();
  const files: ObjectValue[] = [], fieldOrder: string[][] = [];
  for (const file of report.files) {
    if (!object(file)) return plain();
    const original = fileContent(db, projectId, file.id);
    if (!original || file.body !== original.body || ("html" in file && file.html !== original.html)) return plain();
    fieldOrder.push(Object.keys(file));
    files.push(Object.fromEntries(Object.entries(file).filter(([key]) => key !== "body" && key !== "html")));
  }
  const { text: _text, ...response } = result;
  return { kind: "report-reference-v1", value: encodeStoredText(JSON.stringify({ response, report: { ...report, files }, fieldOrder })) };
}

export function decodeAgentResult<T>(db: Database, projectId: string, kind: string, value: unknown): T {
  const saved: unknown = JSON.parse(decodeStoredText(value));
  if (kind === "json") return saved as T;
  if (kind !== "report-reference-v1" || !object(saved) || !object(saved.response) || !object(saved.report) || !Array.isArray(saved.report.files) || !Array.isArray(saved.fieldOrder) || saved.fieldOrder.length !== saved.report.files.length) {
    throw new Error("지원하지 않거나 손상된 도구 결과 저장 형식입니다");
  }
  const report = saved.report;
  const files = (report.files as unknown[]).map((file, index) => {
    if (!object(file)) throw new Error("보고 자료 참조가 잘못되었습니다");
    const original = fileContent(db, projectId, file.id);
    if (!original) throw new Error("보고 자료 원본을 찾을 수 없습니다");
    const fields: unknown = (saved.fieldOrder as unknown[])[index];
    if (!Array.isArray(fields) || fields.some(key => typeof key !== "string")) throw new Error("보고 자료 필드가 잘못되었습니다");
    return Object.fromEntries(fields.map(key => [key, key === "body" ? original.body : key === "html" ? original.html : file[key]]));
  });
  return { ...saved.response, text: JSON.stringify({ ...report, files }) } as T;
}

/** Runs inside the schema-version transaction. Never removes an unmatched historical row. */
export function migrateStoredContent(db: Database): void {
  const before = storageContentDigest(db, true);
  const updateFile = db.query("UPDATE files SET body = ?, html = ? WHERE id = ?");
  for (const row of db.query<{ id: string; body: unknown; html: unknown }, []>("SELECT id,body,html FROM files ORDER BY rowid").iterate()) {
    updateFile.run(encodeStoredText(decodeStoredText(row.body)), row.html === null ? null : encodeStoredText(decodeStoredText(row.html)), row.id);
  }
  type Receipt = { operation_id: string; member_id: string; project_id: string; tool_name: string; request_json: unknown; result_json: unknown; created_at: string; updated_at: string | null; state: AgentReceiptState };
  const get = db.query<Receipt, [string]>("SELECT * FROM agent_operation_receipts WHERE operation_id = ?");
  const paired = db.query<{ operation_id: string }, []>("SELECT operation_id FROM agent_operation_receipts WHERE operation_id LIKE 'agent-result:%' ORDER BY rowid").all();
  for (const { operation_id: childId } of paired) {
    const child = get.get(childId)!, parent = get.get(childId.slice("agent-result:".length));
    if (!parent || parent.member_id !== child.member_id || parent.project_id !== child.project_id || parent.tool_name !== child.tool_name || decodeStoredText(parent.request_json) !== decodeStoredText(child.request_json)) continue;
    db.query("UPDATE agent_operation_receipts SET result_json = ?, state = 'completed', updated_at = ? WHERE operation_id = ?").run(decodeStoredText(child.result_json), child.created_at, parent.operation_id);
    db.query("DELETE FROM agent_operation_receipts WHERE operation_id = ?").run(childId);
  }
  const update = db.query("UPDATE agent_operation_receipts SET request_json = ?, request_sha256 = ?, result_json = ?, result_kind = ?, state = ?, updated_at = COALESCE(updated_at,created_at) WHERE operation_id = ?");
  for (const row of db.query<Receipt, []>("SELECT * FROM agent_operation_receipts ORDER BY rowid").iterate()) {
    const request = decodeStoredText(row.request_json), result: unknown = JSON.parse(decodeStoredText(row.result_json));
    const encoded = encodeAgentResult(db, row.project_id, row.tool_name, JSON.parse(request), result);
    const reserved = row.updated_at === null && !row.operation_id.startsWith("agent-result:") && object(result) && result.text === UNKNOWN_AGENT_RESULT.text && result.isError === true;
    update.run(encodeStoredText(request), agentRequestHash(request), encoded.value, encoded.kind, reserved ? "reserved" : row.state, row.operation_id);
  }
  if (canonicalAgentRequest(before) !== canonicalAgentRequest(storageContentDigest(db))) throw new Error("저장 최적화 원문 검증에 실패했습니다. 변경을 취소합니다");
}

/** Logical fingerprints, never content: normalize only the legacy reservation/result pair. */
export function storageContentDigest(db: Database, legacy = false): { files: string; receipts: string; fileCount: number; receiptCount: number } {
  const files = createHash("sha256"), receipts = createHash("sha256");
  let fileCount = 0, receiptCount = 0;
  for (const row of db.query<Record<string, unknown>, []>("SELECT * FROM files ORDER BY id COLLATE BINARY").iterate()) {
    files.update(canonicalAgentRequest({ ...row, body: decodeStoredText(row.body), html: row.html === null ? null : decodeStoredText(row.html) }) + "\n");
    fileCount++;
  }
  type Receipt = { operation_id: string; member_id: string; project_id: string; tool_name: string; request_json: unknown; result_json: unknown; result_kind?: string; state?: string; created_at: string };
  const get = db.query<Receipt, [string]>("SELECT * FROM agent_operation_receipts WHERE operation_id = ?");
  const matches = (a: Receipt | null, b: Receipt | null): boolean => !!a && !!b && a.member_id === b.member_id && a.project_id === b.project_id && a.tool_name === b.tool_name && decodeStoredText(a.request_json) === decodeStoredText(b.request_json);
  for (const row of db.query<Receipt, []>("SELECT * FROM agent_operation_receipts ORDER BY operation_id COLLATE BINARY").iterate()) {
    if (legacy && row.operation_id.startsWith("agent-result:") && matches(row, get.get(row.operation_id.slice("agent-result:".length)))) continue;
    const child = legacy ? get.get(`agent-result:${row.operation_id}`) : null;
    const paired = matches(row, child);
    const chosen = paired ? child! : row;
    const result = decodeAgentResult<unknown>(db, row.project_id, chosen.result_kind ?? "json", chosen.result_json);
    const reserved = !paired && !row.operation_id.startsWith("agent-result:") && object(result) && result.text === UNKNOWN_AGENT_RESULT.text && result.isError === true;
    receipts.update(canonicalAgentRequest({ id: row.operation_id, member: row.member_id, project: row.project_id, tool: row.tool_name,
      request: decodeStoredText(row.request_json), result, state: legacy ? reserved ? "reserved" : "completed" : row.state, at: row.created_at }) + "\n");
    receiptCount++;
  }
  return { files: files.digest("hex"), receipts: receipts.digest("hex"), fileCount, receiptCount };
}
