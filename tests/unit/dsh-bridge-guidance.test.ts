import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

it('does not emit the old completion when guidance arrives during native persistence or prompt admission', async () => {
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const flushing = deferred(), flushRelease = deferred(), admissionRelease = deferred();
  const listeners = new Map<string, (...args: unknown[]) => void>(), disposers: Array<() => Promise<void> | void> = [];
  const token = 'e'.repeat(64), previous = process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN;
  process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN = token;
  let port = 0, flushes = 0, prompts = 0;
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(((value: string | Uint8Array) => {
    const match = /^WORLDLINEBOX_DSH_BRIDGE_READY (\d+)/u.exec(String(value)); if (match) port = Number(match[1]); return true;
  }) as typeof process.stdout.write);
  const agent = { status: 'idle', session: { id: randomUUID(), seq: 0 }, ctx: { get: () => undefined }, whenIdle: async () => undefined };
  const ctx = { loader: { await: async () => undefined }, tools: { guard: () => () => undefined, schemas: () => [] },
    workspaceRegistry: {}, agents: { get: () => agent }, agentPresets: { defaultId: 'standard', list: async () => [{ id: 'standard' }] },
    sessions: { flush: async () => { if (++flushes === 1) { flushing.resolve(); await flushRelease.promise; } } },
    get: () => undefined, on: (name: string, callback: (...args: unknown[]) => void) => listeners.set(name, callback),
    effect: (callback: () => (() => Promise<void> | void)) => disposers.push(callback()),
    sessionController: { create: async () => ({ sessionId: agent.session.id }), resolveAgent: async () => ({ agent }),
      prompt: async () => {
        const second = ++prompts === 2;
        if (second) await admissionRelease.promise;
        agent.session.seq++;
        listeners.get('session/event')!(agent.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: second ? '按引导完成' : '旧结果' }] } } });
        listeners.get('session/event')!(agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
        return { accepted: true };
      } } };
  const signal = new AbortController(), events: Array<{ type: string; text?: string; status?: string }> = [];
  let pump: Promise<void> | undefined;
  try {
    const bridgePath = '../../resources/dsh-bridge/index.js'; const bridge = await import(bridgePath); await bridge.apply(ctx);
    await vi.waitFor(() => expect(port).toBeGreaterThan(0)); output.mockRestore();
    const post = async (route: string, body: object) => { const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200); return response.json(); };
    const id = agent.session.id; await post('/sessions', { sessionId: id, cwd: tmpdir() });
    const stream = await fetch(`http://127.0.0.1:${port}/sessions/${id}/events`, { headers: { Authorization: 'Bearer ' + token }, signal: signal.signal });
    pump = (async () => { let pending = ''; for await (const chunk of stream.body!) { pending += new TextDecoder().decode(chunk); const lines = pending.split('\n'); pending = lines.pop()!; for (const line of lines) if (line) events.push(JSON.parse(line)); } })().catch(() => undefined);
    listeners.get('session/event')!(agent.session, { type: 'approval/asked', data: { id: 'permission-fixture', toolName: 'pwsh', callId: 'actual-call', reason: '启动浏览器需要确认' } });
    listeners.get('session/event')!(agent.session, { type: 'approval/decided', data: { id: 'permission-fixture', outcome: 'allowed-once' } });
    await vi.waitFor(() => expect(events.filter(event => event.type.startsWith('approval_')).map(event => ({ type: event.type, data: JSON.parse(event.text!) })))
      .toEqual([{ type: 'approval_required', data: { requestId: 'permission-fixture', reason: '启动浏览器需要确认' } },
        { type: 'approval_decided', data: { requestId: 'permission-fixture', outcome: 'allowed-once' } }]));
    await post(`/sessions/${id}/prompt`, { prompt: '原任务' }); await flushing.promise;
    const guidance = post(`/sessions/${id}/prompt`, { prompt: '改为展示', mode: 'steer' });
    await vi.waitFor(() => expect(prompts).toBe(2)); flushRelease.resolve(); await delay(100);
    expect(events.filter(event => event.type === 'complete')).toEqual([]);
    admissionRelease.resolve(); await guidance;
    await vi.waitFor(() => expect(events.filter(event => event.type === 'complete')).toEqual([{ ...events.find(event => event.type === 'complete'), type: 'complete', status: 'succeeded', text: '按引导完成' }]));
  } finally {
    output.mockRestore(); flushRelease.resolve(); admissionRelease.resolve(); signal.abort(); await pump;
    for (const dispose of disposers.reverse()) await dispose();
    if (previous === undefined) delete process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN; else process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN = previous;
  }
});
