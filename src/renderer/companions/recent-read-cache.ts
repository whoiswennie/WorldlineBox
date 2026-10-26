/** Small renderer-only snapshots. The host remains authoritative on every visit. */
export class CompanionRecentReadCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  generation = 0;

  constructor(readonly maxEntries = 8, readonly maxBytes = 8 * 1024 * 1024, readonly scope?: object) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, generation = this.generation): void {
    if (generation !== this.generation) return;
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const previous = this.entries.get(key);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
  }

  clear(): void { this.entries.clear(); this.bytes = 0; ++this.generation; }
  snapshot() { return { entries: this.entries.size, bytes: this.bytes, maxEntries: this.maxEntries, maxBytes: this.maxBytes }; }
}
