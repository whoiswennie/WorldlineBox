import { botModelsMetadataUrl, resolveBotModelLimits, type BotModelLimitInput, type BotModelLimits } from './model-limits';

interface Entry { expires: number; metadata?: unknown; controller?: AbortController }
/** Model discovery is cached application metadata, never a per-turn inference
 * request or a dependency on a DSH profile/Host. Credentials are not retained. */
export class BotModelCapabilities {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly options: { fetchFn?: typeof fetch; changed?(): void; now?(): number } = {}) {}
  current(input: BotModelLimitInput & { apiKey?: string; apiFormat?: string }): BotModelLimits {
    const key = JSON.stringify([input.apiFormat, input.baseUrl, input.model]);
    let entry = this.entries.get(key);
    const now = this.options.now?.() ?? Date.now();
    if (!entry) {
      if (this.entries.size >= 8) {
        const oldest = this.entries.entries().next().value as [string, Entry] | undefined;
        if (oldest) { oldest[1].controller?.abort(); this.entries.delete(oldest[0]); }
      }
      entry = { expires: 0 }; this.entries.set(key, entry);
    }
    if (!this.closed && !entry.controller && entry.expires <= now && input.apiFormat === 'openai_chat' && input.apiKey && !/[\r\n]/u.test(input.apiKey)) {
      let url: string | undefined;
      try { url = botModelsMetadataUrl(input.baseUrl); } catch { /* Unknown configuration keeps a disclosed conservative limit. */ }
      if (url) {
        const controller = new AbortController(); entry.controller = controller; entry.expires = now + 600000;
        const selected = entry, credential = input.apiKey;
        void (async () => {
          try {
            const response = await (this.options.fetchFn ?? fetch)(url, { method: 'GET', redirect: 'error',
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), headers: { authorization: `Bearer ${credential}` } });
            if (!response.ok) { await response.body?.cancel(); return; }
            const reader = response.body?.getReader(); if (!reader) return;
            const chunks: Uint8Array[] = []; let size = 0;
            try { while (true) { const chunk = await reader.read(); if (chunk.done) break;
              size += chunk.value.byteLength; if (size > 1024 * 1024) throw new Error('Model metadata response exceeds capacity'); chunks.push(chunk.value); }
            } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
            const metadata: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (this.closed || this.entries.get(key) !== selected) return;
            selected.metadata = metadata;
            if (resolveBotModelLimits(input, metadata).source === 'metadata') this.options.changed?.();
          } catch { /* Discovery failure does not disable an already usable chat connection. */ }
          finally { if (selected.controller === controller) selected.controller = undefined; }
        })();
      }
    }
    return resolveBotModelLimits(input, entry.metadata);
  }
  close(): void { this.closed = true; for (const entry of this.entries.values()) entry.controller?.abort(); this.entries.clear(); }
}
