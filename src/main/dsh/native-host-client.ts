import type { DshTaskEvent } from '../../shared/dsh-tasks';

export const NATIVE_HOST_PROTOCOL = 'worldlinebox-native-web-host-v1';
export interface NativeHostEvent extends Omit<DshTaskEvent, 'taskId'> {
  status?: 'succeeded' | 'failed' | 'cancelled';
  error?: string;
  reason?: { kind: string };
}

/** Authenticated loopback transport to a standard plugin in the actual Web Host. */
export class NativeHostClient {
  constructor(readonly port: number, private readonly token: string, readonly pid: number) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid native Host connection.');
  }
  private async response(endpoint: string, input?: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(`http://127.0.0.1:${this.port}${endpoint}`, {
      method: input === undefined ? 'GET' : 'POST', signal,
      headers: { authorization: `Bearer ${this.token}`, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), redirect: 'error',
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(`${endpoint.split('?')[0]}: ${failure.error ?? `Native Web Host returned HTTP ${response.status}.`}`);
    }
    return response;
  }
  async request<T>(endpoint: string, input?: unknown, signal?: AbortSignal): Promise<T> {
    return (await this.response(endpoint, input, signal ?? AbortSignal.timeout(30000))).json() as Promise<T>;
  }
  async health(signal?: AbortSignal): Promise<void> {
    const value = await this.request<{ protocol: string; pid: number }>('/health', undefined, signal);
    if (value.protocol !== NATIVE_HOST_PROTOCOL || value.pid !== this.pid) throw new Error('Native Web Host identity mismatch.');
  }
  /** Server pushes session events; a task never polls or creates another CLI. */
  async *events(sessionId: string, after: number, signal: AbortSignal): AsyncGenerator<NativeHostEvent> {
    const response = await this.response(`/sessions/${encodeURIComponent(sessionId)}/events?after=${after}`, undefined, signal);
    if (!response.body) throw new Error('Native Host event stream is unavailable.');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        if (pending.length > 2 * 1024 * 1024) throw new Error('Native event exceeds its frame limit.');
        let boundary: number;
        while ((boundary = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
          if (line) yield JSON.parse(line) as NativeHostEvent;
        }
      }
      if (!signal.aborted) throw new Error('The native Web Host event stream disconnected.');
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
