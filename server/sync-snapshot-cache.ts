/** Short-lived serialized web snapshots. Reads update LRU order, never expiry. */
export class SyncSnapshotCache {
  private entries = new Map<string, { value: string; bytes: number; expiresAt: number }>();
  private bytes = 0;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: { now?: () => number; ttlMs?: number; maxEntries?: number; maxBytes?: number } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.ttlMs = options.ttlMs ?? 250;
    this.maxEntries = options.maxEntries ?? 32;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.remove(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    this.remove(key);
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.remove(key);
    const bytes = Buffer.byteLength(value);
    if (bytes > this.maxBytes || this.maxEntries < 1 || this.ttlMs <= 0) return;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { value, bytes, expiresAt: now + this.ttlMs });
    this.bytes += bytes;
  }
}
