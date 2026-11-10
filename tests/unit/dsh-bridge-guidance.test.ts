import { expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';

it('registers the companion preset during direct CLI startup even without a Host token', async () => {
  const previous = process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN;
  delete process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN;
  const list = vi.fn(async () => [{ id: 'worldlinebox-companion-v2' }]), effect = vi.fn();
  try {
    const bridgePath = '../../resources/dsh-bridge/index.js', bridge = await import(bridgePath);
    await bridge.apply({ agentPresets: { list }, effect, on: vi.fn() });
    expect(list).toHaveBeenCalledOnce(); expect(effect).toHaveBeenCalledOnce();
  } finally { if (previous !== undefined) process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN = previous; }
});

it('recovers only missing ephemeral Workbench routes using an actually registered native default', async () => {
  const bridgePath = '../../resources/dsh-bridge/index.js', bridge = await import(bridgePath);
  const select = vi.fn(), fallback = { provider: 'native', model: 'configured-native-model' };
  let current = { provider: 'worldlinebox-bot-old', model: 'old' }, providers = [{ id: 'native' }];
  const ctx = { llm: { listProviders: () => providers }, get: () => ({ currentSelection: () => fallback }) };
  const agent = { model: { current: () => current, select } };
  bridge.restoreWorkbenchModel(ctx, agent); expect(select).toHaveBeenCalledExactlyOnceWith(fallback);
  select.mockClear(); providers.push({ id: current.provider }); bridge.restoreWorkbenchModel(ctx, agent); expect(select).not.toHaveBeenCalled();
  providers = []; bridge.restoreWorkbenchModel(ctx, agent); expect(select).not.toHaveBeenCalled();
  current = { provider: 'user-selected-provider', model: 'manual' }; providers = [{ id: 'native' }];
  bridge.restoreWorkbenchModel(ctx, agent); expect(select).not.toHaveBeenCalled();
});

it('discovers the actual companion scope without assuming newer native turn-boundary APIs exist', async () => {
  const previous = process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN, token = 'c'.repeat(64);
  process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN = token;
  const disposers: Array<() => unknown> = [], created: string[] = [];
  let port = 0;
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(((value: string | Uint8Array) => {
    const match = /^WORLDLINEBOX_DSH_BRIDGE_READY (\d+)/u.exec(String(value)); if (match) port = Number(match[1]); return true;
  }) as typeof process.stdout.write);
  const agent = { status: 'idle', session: { id: 'discovery', seq: 0 }, ctx: { get: () => undefined } };
  const ctx = { loader: { await: async () => undefined }, tools: { guard: () => () => undefined, schemas: () => [{ name: 'actual_scoped_tool', parameters: { private: true } }] },
    workspaceRegistry: {}, agents: { get: () => agent }, agentPresets: { defaultId: 'standard', list: async () => [{ id: 'standard' }, { id: 'worldlinebox-companion-v2' }] },
    get: () => undefined, on: vi.fn(), effect: (callback: () => (() => unknown)) => disposers.push(callback()),
    sessionController: { create: async (input: { sessionId: string; agentPreset: string }) => { expect(input.agentPreset).toBe('worldlinebox-companion-v2'); created.push(input.sessionId); return { sessionId: input.sessionId }; },
      resolveAgent: async () => ({ agent }) } };
  try {
    const bridgePath = '../../resources/dsh-bridge/index.js', bridge = await import(bridgePath); await bridge.apply(ctx); output.mockRestore();
    const query = () => fetch(`http://127.0.0.1:${port}/capabilities`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'discovery', cwd: tmpdir(), companion: true, query: { kind: 'summary' } }) });
    const first = await query(); expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ preset: 'worldlinebox-companion-v2', effective: { toolCount: 1 }, tools: [], scope: { kind: 'companion-worker', pending: false } });
    expect((await query()).status).toBe(200); expect(created).toHaveLength(1);
  } finally {
    output.mockRestore(); for (const dispose of disposers.reverse()) await dispose();
    if (previous === undefined) delete process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN; else process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN = previous;
  }
});
