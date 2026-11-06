import { expect, it } from 'vitest';
import { BotToolServer } from '../../src/main/companion-bot/tool-server';

it('revokes in-flight callbacks before a paused task obtains a fresh callback capability', async () => {
  let release!: () => void, entered!: () => void, oldSignal: AbortSignal | undefined, publications = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), admitted = new Promise<void>(resolve => { entered = resolve; });
  const server = new BotToolServer(async (_call, signal) => {
    if (!oldSignal) { oldSignal = signal; entered(); await gate; }
    signal.throwIfAborted(); publications++; return { sent: true };
  });
  const send = (capability: { url: string; token: string }) => fetch(capability.url, { method: 'POST', headers: { authorization: `Bearer ${capability.token}` },
    body: JSON.stringify({ laneId: 'worker-task', eventId: 'work-task', callId: 'publish', name: 'worker_chat_send_file', args: { path: 'output.txt' } }) });
  try {
    const original = await server.forWorker('worker-task', 'work-task'), old = send(original);
    await admitted; server.releaseWorker('worker-task');
    expect(oldSignal?.aborted).toBe(true);
    const resumed = await server.forWorker('worker-task', 'work-task');
    expect((await send(original)).status).toBe(401);
    expect((await send(resumed)).status).toBe(200);
    release(); expect((await old).status).toBe(400);
    expect(publications).toBe(1);
  } finally { release(); await server.close(); }
});
