import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('preserves guidance/cancel semantics, evicts idle native lanes and compacts actual growing history', async () => {
  const seen: Array<{ chars: number; summary: boolean; guidance: number; leaked: boolean; localRead: boolean }> = [];
  let held: ServerResponse | undefined, notify!: () => void;
  const waiting = () => new Promise<void>(resolve => { notify = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url === '/bot/tool') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: data.name === 'worker_effect_start' ? { state: 'admitted', callId: data.callId } : { recorded: true } })); return;
    }
    const text = data.messages.map((message: { content?: string }) => message.content ?? '').join('\n');
    const summary = text.includes('You are now acting as a compaction engine');
    seen.push({ chars: JSON.stringify(data.messages).length, summary, guidance: text.split('GUIDANCE_DIRECTIVE').length - 1,
      leaked: JSON.stringify(data).includes('SHOULD_NOT_LEAK'), localRead: JSON.stringify(data).includes('SCOPED_LOCAL_OK') });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (text.includes('hold-for-control') && !text.includes('GUIDANCE_DIRECTIVE')) { held = response; notify(); return; }
    const content = summary ? '## Primary Request and Intent\n- Continue this companion conversation.\n## Key Technical Concepts\n- Context continuity.\n## Files and Code\n- (none)\n## Errors and Fixes\n- (none)\n## Pending Jobs\n- (none)\n## Current Work\n- User is checking native compaction.\n## Next Step\n- Respond to the latest message.\n## Critical Context\n- Preserve the factual marker CEDAR_PIN.' : 'native-output';
    const haveTool = data.messages.some((message: { role: string }) => message.role === 'tool');
    let call;
    if (text.includes('READ_PROBE:') && !haveTool) call = { name: 'read', args: { file_path: text.match(/READ_PROBE:([^\n]+)/)![1]!.trim() } };
    if (text.includes('SHELL_PROBE') && !haveTool) call = { name: 'pwsh', args: { description: 'Write the authorized native shell verification artifact', command: "Set-Content -LiteralPath full-proof.txt -Value NATIVE_FULL_OK", timeoutMs: 10000 } };
    const delta = call ? { tool_calls: [{ index: 0, id: 'native-probe-call', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content };
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: Math.ceil(JSON.stringify(data.messages).length / 3), completion_tokens: summary ? 150 : 10 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No native fixture port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const client = await native.instances.ensureHost(native.instance.id);
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const base = { laneId: 'guidance', eventId: 'guidance-event', cwd: path.join(native.root, 'guidance'), system: 'Companion native reliability fixture.', prompt: 'hold-for-control',
    model: { apiFormat: 'openai_chat' as const, baseUrl, model: 'protocol-fixture', apiKey: 'protocol-fixture', contextWindow: 8192, maxTokens: 1024 },
    tools: [], callback: { url: baseUrl + '/bot/tool', token: 'f'.repeat(64) } };
  await mkdir(base.cwd);
  try {
    let ready = waiting();
    const guided = brain.run(base); await ready;
    await brain.send(base.laneId, { messageId: 'durable-guidance-id', text: 'GUIDANCE_DIRECTIVE: continue with the corrected scope.', mode: 'steer' });
    await brain.send(base.laneId, { messageId: 'durable-guidance-id', text: 'GUIDANCE_DIRECTIVE: continue with the corrected scope.', mode: 'steer' });
    held!.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'old partial' }, finish_reason: 'stop' }] }) + '\n\n'); held!.end('data: [DONE]\n\n');
    expect((await guided).text).toBe('native-output');
    expect(seen.at(-1)?.guidance).toBe(1);
    const cancelInput = { ...base, laneId: 'cancel-lane', eventId: 'cancel-event', cwd: path.join(native.root, 'cancel') };
    ready = waiting(); const cancelling = brain.run(cancelInput); await ready;
    await brain.cancel(cancelInput.laneId); expect((await cancelling).status).toBe('cancelled');
    expect((await brain.run(cancelInput)).status).toBe('cancelled');
    const privateRoot = path.join(native.root, 'private-domain'), scopedRoot = path.join(native.root, 'scoped-worker');
    await mkdir(privateRoot); await mkdir(scopedRoot);
    await writeFile(path.join(privateRoot, 'private.txt'), 'SHOULD_NOT_LEAK');
    await writeFile(path.join(scopedRoot, 'allowed.txt'), 'SCOPED_LOCAL_OK');
    await symlink(privateRoot, path.join(scopedRoot, 'outside-link'), 'junction');
    const scoped = { ...base, role: 'worker' as const, workerAccess: 'scoped' as const, laneId: 'scoped-worker', cwd: scopedRoot };
    await brain.run({ ...scoped, eventId: 'scoped-read-absolute', prompt: 'READ_PROBE:' + path.join(privateRoot, 'private.txt') });
    await brain.run({ ...scoped, laneId: 'scoped-alias', eventId: 'scoped-read-junction', prompt: 'READ_PROBE:outside-link/private.txt' });
    await brain.run({ ...scoped, laneId: 'scoped-shell', eventId: 'scoped-deny-shell', prompt: 'SHELL_PROBE' });
    await brain.run({ ...scoped, laneId: 'scoped-local', eventId: 'scoped-local-read', prompt: 'READ_PROBE:allowed.txt' });
    expect(seen.some(request => request.leaked)).toBe(false);
    expect(seen.some(request => request.localRead)).toBe(true);
    expect(await access(path.join(scopedRoot, 'full-proof.txt')).then(() => true, () => false)).toBe(false);
    const fullCwd = path.join(native.root, 'trusted-owner-worker');
    await brain.run({ ...base, role: 'worker', workerAccess: 'full', laneId: 'full-worker', eventId: 'full-shell-execution', cwd: fullCwd, prompt: 'SHELL_PROBE' });
    expect((await readFile(path.join(fullCwd, 'full-proof.txt'), 'utf8')).trim()).toBe('NATIVE_FULL_OK');
    const beforeArchive = (await client.request<{ botLanes: number }>('/health')).botLanes;
    await brain.archive('full-worker'); await brain.archive('full-worker');
    expect((await client.request<{ botLanes: number }>('/health')).botLanes).toBe(beforeArchive - 1);
    const countsBefore = seen.length;
    for (let i = 0; i < 18; i++) await brain.run({ ...base, laneId: `eviction-${i}`, eventId: `eviction-event-${i}`, cwd: path.join(native.root, 'lanes', String(i)), prompt: 'reply directly' });
    expect((await client.request<{ botLanes: number }>('/health')).botLanes).toBeLessThanOrEqual(16);
    const beforeReplay = seen.length; expect((await brain.run(base)).text).toBe('native-output'); expect(seen.length).toBe(beforeReplay);
    expect(seen.length).toBeGreaterThan(countsBefore);
    const payload = 'Conversation detail that may be compacted later. '.repeat(85);
    for (let i = 0; i < 14; i++) await brain.run({ ...base, laneId: 'compact-lane', eventId: `compact-event-${i}`, cwd: path.join(native.root, 'compact'),
      prompt: `Message ${i}; factual marker CEDAR_PIN. ${payload}` });
    expect(seen.filter(request => request.summary).length).toBeGreaterThan(0);
    const regular = seen.filter(request => !request.summary);
    expect(regular.at(-1)!.chars).toBeLessThan(payload.length * 14 / 2);
    expect((await client.request<{ botCompactions: number }>('/health')).botCompactions).toBeGreaterThan(0);
    const handoffInput = { ...base, laneId: 'compact-lane', eventId: 'compact-event-13', cwd: path.join(native.root, 'compact') };
    const handoff = await brain.handoff(handoffInput);
    expect(handoff.summaryText).toContain('CEDAR_PIN'); expect(handoff.coveredEventSeqs.length).toBeGreaterThan(0);
    expect(handoff.nativeCursor).toBeGreaterThan(handoff.summarySeq);
    const beforeHandoffReplay = seen.length;
    expect(await brain.handoff(handoffInput)).toEqual(handoff); expect(seen.length).toBe(beforeHandoffReplay);
    expect((await brain.run({ ...base, laneId: 'compact-epoch-2', eventId: 'epoch-2-input', cwd: path.join(native.root, 'epoch-2'),
      prompt: JSON.stringify({ handoff, latestMessage: 'Continue the conversation using the native checkpoint.' }) })).text).toBe('native-output');
    expect(seen.at(-1)!.chars).toBeLessThan(16000);
    const health = await client.request<{ botLanes: number; botCompactions: number }>('/health');
    await mkdir(path.resolve('artifacts/superagent-bot-development'), { recursive: true });
    await writeFile(path.resolve('artifacts/superagent-bot-development/native-reliability.json'), JSON.stringify({
      version: native.runtimeVersion, provider: 'local-protocol-fixture', actualNativeHost: true, usesRealModel: false,
      guidanceCopies: 1, explicitCancelReplay: 'cancelled', extraLanes: 18, residentLanes: health.botLanes,
      turnsBeforeCompaction: 14, summaryRequests: seen.filter(request => request.summary).length,
      compactionEndEvents: health.botCompactions, lastRegularRequestChars: regular.at(-1)!.chars,
      lifetimePayloadChars: payload.length * 14, coldDuplicateReplaysWithoutModel: true,
      explicitArchiveReleasesResidentLane: true,
      handoff: { summaryChars: handoff.summaryText.length, tailMessages: handoff.tail.length,
        coveredNodes: handoff.coveredEventSeqs.length, nativeCursor: handoff.nativeCursor, idempotent: true, newEpochRequestChars: seen.at(-1)!.chars },
      access: { scopedLocalReadVerified: true, scopedAbsoluteReadBlocked: true, scopedJunctionReadBlocked: true, scopedShellNotExecuted: true, trustedFullShellArtifactVerified: true },
    }, null, 2));
  } finally {
    await brain.close().catch(() => undefined); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 240000);
