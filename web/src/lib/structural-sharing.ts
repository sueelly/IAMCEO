/** Reuse equal JSON domain values from the previous snapshot. Neither input is mutated. */
export function shareJSON<T>(previous: unknown, incoming: T): T {
  if (Object.is(previous, incoming)) return incoming;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    let result: unknown[] | undefined;
    let indexed = false;
    let byID: Map<string | number, unknown> | undefined;
    for (let i = 0; i < incoming.length; i++) {
      let before = previous[i];
      const id = rowID(incoming[i]);
      if (id !== undefined && id !== rowID(before)) {
        if (!indexed) { byID = indexRows(previous, incoming); indexed = true; }
        if (byID) before = byID.get(id);
      }
      const value = shareJSON(before, incoming[i]);
      if (!result && (i >= previous.length || !Object.is(value, previous[i]))) result = previous.slice(0, i);
      if (result) result.push(value);
    }
    return (result ?? (previous.length === incoming.length ? previous : previous.slice(0, incoming.length))) as T;
  }
  if (!isPlainObject(previous) || !isPlainObject(incoming)) return incoming;
  const keys = Object.keys(incoming);
  const create = () => Object.create(Object.getPrototypeOf(incoming)) as Record<string, unknown>;
  let result = keys.length === Object.keys(previous).length && Object.getPrototypeOf(previous) === Object.getPrototypeOf(incoming)
    ? undefined : create();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i], present = Object.hasOwn(previous, key);
    const value = present ? shareJSON(previous[key], incoming[key]) : incoming[key];
    if (!result && (!present || !Object.is(value, previous[key]))) {
      result = create();
      for (let j = 0; j < i; j++) put(result, keys[j], previous[keys[j]]);
    }
    if (result) put(result, key, value);
  }
  return (result ?? previous) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rowID(value: unknown): string | number | undefined {
  if (!isPlainObject(value) || !Object.hasOwn(value, "id")) return undefined;
  return typeof value.id === "string" || typeof value.id === "number" ? value.id : undefined;
}

/** Build an ID lookup only when positional matching first encounters a moved row. */
function indexRows(previous: unknown[], incoming: unknown[]): Map<string | number, unknown> | undefined {
  const rows = new Map<string | number, unknown>(), incomingIDs = new Set<string | number>();
  for (const row of previous) {
    const id = rowID(row);
    if (id === undefined || rows.has(id)) return undefined;
    rows.set(id, row);
  }
  for (const row of incoming) {
    const id = rowID(row);
    if (id === undefined || incomingIDs.has(id)) return undefined;
    incomingIDs.add(id);
  }
  return rows;
}

function put(target: Record<string, unknown>, key: string, value: unknown): void {
  // JSON keys such as __proto__ are data, not setters on Object.prototype.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}
