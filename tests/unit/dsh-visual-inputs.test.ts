import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { snapshotDshTaskExecution, type DshTaskVisualInput } from '../../src/main/dsh/task-execution';
import { validateDshTaskVisualInputs } from '../../src/main/dsh/task-visual-inputs';
import { dshTaskInputSchema } from '../../src/shared/dsh-tasks';
import { dshTaskSpecSchema } from '../../src/shared/dsh-task-spec';

async function image(): Promise<DshTaskVisualInput> {
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#224466' } }).png().toBuffer();
  return { mime: 'image/png', dataBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
    source: { kind: 'observation_frame', sourceId: 'window:1:0', observedAt: '2026-10-29T10:00:00.000Z', offsetMs: 1200 } };
}
it('admits host-scope decoded pixels but rejects hash/MIME tampering and public model/renderer injection', async () => {
  const visual = await image(), scope = { actionId: randomUUID(), companionId: 'alice', conversationId: 'own_room',
    agendaOrigin: { runId: 'run', ruleId: 'rule', occurrenceId: 'occurrence', grantId: 'grant', grantRevision: 1 } };
  const accepted = snapshotDshTaskExecution({ cognitiveOnly: true, recordScope: scope, workspaceRootPath: tmpdir(), visualInputs: [visual] });
  expect(accepted.task).toMatchObject({ tools: [], skills: [], session: { mode: 'new' } });
  expect(await validateDshTaskVisualInputs(accepted.visualInputs)).toEqual([{ mime: visual.mime, sha256: visual.sha256, source: visual.source }]);
  await expect(validateDshTaskVisualInputs([{ ...visual, sha256: '0'.repeat(64) }])).rejects.toThrow('digest');
  await expect(validateDshTaskVisualInputs([{ ...visual, mime: 'image/jpeg' }])).rejects.toThrow('MIME');
  expect(() => snapshotDshTaskExecution({ visualInputs: [visual] })).toThrow('trusted');
  expect(dshTaskInputSchema.safeParse({ prompt: '伪造图片输入', visualInputs: [visual] }).success).toBe(false);
  expect(dshTaskSpecSchema.safeParse({ visualInputs: [visual] }).success).toBe(false);
});

it('sends the exact SDK image blocks through the authenticated native bridge and rejects unbound or changed pixels', async () => {
  const visual = await image(), manifest = [{ mime: visual.mime, sha256: visual.sha256, source: visual.source }];
  const token = 'a'.repeat(64), previous = process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN; process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN = token;
  let port = 0; const disposers: Array<() => unknown> = [], prompt = vi.fn(async (input: unknown) => { void input; return { accepted: true }; });
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(((value: string | Uint8Array) => {
    const match = /^WORLDLINEBOX_DSH_BRIDGE_READY (\d+)/u.exec(String(value)); if (match) port = Number(match[1]); return true;
  }) as typeof process.stdout.write);
  const agent = { id: 'agent', status: 'idle', session: { id: randomUUID(), append: vi.fn() }, whenIdle: async () => undefined,
    ctx: { get: () => undefined, tools: { restrict: vi.fn(() => () => undefined) }, on: vi.fn(() => () => undefined) } };
  const ctx = { loader: { await: async () => undefined }, tools: { guard: () => () => undefined, schemas: () => [] }, agents: { get: () => agent },
    agentPresets: { defaultId: 'standard', list: async () => [{ id: 'standard' }] }, workspaceRegistry: {}, sessions: { flush: async () => undefined }, get: () => undefined, on: vi.fn(),
    effect: (callback: () => (() => unknown)) => disposers.push(callback()),
    sessionController: { create: async () => ({ sessionId: agent.session.id }), resolveAgent: async () => ({ agent }), prompt } };
  try {
    const bridgePath = '../../resources/dsh-bridge/index.js', bridge = await import(bridgePath); await bridge.apply(ctx); expect(port).toBeGreaterThan(0); output.mockRestore();
    const post = (route: string, body: object, auth = token) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST',
      headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/sessions', { sessionId: agent.session.id, cwd: tmpdir() }, 'b'.repeat(64))).status).toBe(401);
    const created = await post('/sessions', { sessionId: agent.session.id, cwd: tmpdir(), accessMode: 'read-only',
      policy: { cognitiveOnly: true, tools: [], skills: [], visualInputManifest: manifest } });
    expect(created.status, JSON.stringify(await created.json())).toBe(200);
    const route = `/sessions/${agent.session.id}/prompt`;
    expect((await post(route, { prompt: '仅看实际抽样画面。', visualInputs: [{ ...visual, sha256: '0'.repeat(64) }] })).status).toBe(500);
    expect(prompt).not.toHaveBeenCalled();
    const accepted = await post(route, { prompt: '仅看实际抽样画面。', visualInputs: [visual] });
    expect(accepted.status).toBe(200); expect(await accepted.json()).toEqual({ accepted: true, visualInputsAccepted: manifest });
    const request = prompt.mock.calls[0]![0] as unknown as { content: Array<{ type: string; mediaType?: string; data?: string; text?: string }> };
    expect(request.content.filter(block => block.type === 'image')).toEqual([{ type: 'image', mediaType: visual.mime, data: visual.dataBase64, name: 'observation-1.png' }]);
    expect(request.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).not.toContain(visual.dataBase64);
    expect(agent.ctx.tools.restrict).toHaveBeenCalledWith({ allow: [] });
    expect((await post(route, { prompt: '不能重复悄悄换图。', visualInputs: [visual] })).status).toBe(500); expect(prompt).toHaveBeenCalledOnce();
  } finally {
    output.mockRestore(); for (const dispose of disposers.reverse()) await dispose();
    if (previous === undefined) delete process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN; else process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN = previous;
  }
});
