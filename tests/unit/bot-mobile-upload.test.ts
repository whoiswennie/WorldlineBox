import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { startMobileGateway } from '../../src/main/companion-bot/mobile-gateway';
import type { BotService } from '../../src/main/companion-bot/service';
import type { BotMediaRef } from '../../src/shared/companion-bot-media';

it('resumes a 201 MiB attachment after a restart and delivers the original bytes as a task input', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-large-upload-'));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const token = '8'.repeat(64), headers = { authorization: 'Bearer ' + token };
  const room = 'fixture-room';
  let attachment: BotMediaRef | undefined;
  const bot = { store: { getConversation: () => ({ kind: 'direct', memberIds: ['user'] }),
    getMessage: () => ({ conversationId: room, attachments: [attachment] }) } } as unknown as BotService;
  const media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
  const start = () => startMobileGateway({ root, bot: async () => bot, media: async () => media, report: () => {} });
  let gateway: Awaited<ReturnType<typeof startMobileGateway>>;
  try {
    await writeFile(path.join(root, 'mobile-access.json'), JSON.stringify({ port, token }));
    gateway = await start();
    const chunk = Buffer.alloc(1024 ** 2), total = 201 * chunk.length;
    const base = 'http://127.0.0.1:' + port + '/mobile/v1/';
    const url = base + 'upload?conversationId=' + room + '&id=' + randomUUID();
    const put = (offset: number) => fetch(url + '&name=delivery.zip&total=' + total + '&offset=' + offset, { method: 'PUT', headers, body: chunk });
    expect((await (await fetch(base+'health', { headers })).json()).maxUploadBytes).toBeGreaterThan(total);
    const hash = createHash('sha256');
    for (let offset = 0; offset < total; offset += chunk.length) {
      chunk.fill(offset / chunk.length); hash.update(chunk);
      const response = await put(offset);
      expect(response.status).toBe(200);
      const body = await response.json(); attachment = body.attachment;
      if (offset === 3 * chunk.length) {
        gateway!.close(); gateway = await start();
        expect((await (await fetch(url, { headers })).json()).offset).toBe(offset + chunk.length);
        expect((await put(offset)).status).toBe(409);
      }
    }
    expect(attachment).toMatchObject({ sha256: hash.digest('hex'), size: total, storage: 'managed', previewEligibility: 'file-only' });
    expect((await media.getForAgent(room, attachment!.id)).ref.id).toBe(attachment!.id);
    const file = await fetch(base+'files?conversationId='+room+'&messageId=fixture&id='+attachment!.id, { headers: { ...headers, range: 'bytes=-16' } });
    expect(file.status).toBe(206); expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.alloc(16,200));
    gateway!.close(); gateway = await start();
    expect((await (await fetch(url, { headers })).json()).attachment.id).toBe(attachment!.id);
  } finally { gateway?.close(); await media.close(); await rm(root, {recursive:true,force:true,maxRetries:4,retryDelay:100}); }
}, 120_000);
