import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { BUILTIN_BOT_COMPANIONS, DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { removeOwnedDirectorySync } from '../helpers/remove-owned-test-directory';

const services: BotService[] = [], roots: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-bot-bootstrap-')) throw Error('Unexpected bootstrap fixture');
    removeOwnedDirectorySync(root);
  }
});
function open(root: string) {
  const unavailable = async (): Promise<never> => { throw Error('Bootstrap must not call model or memory worker'); };
  const service = new BotService({ root, brain: new BotDshBrain({ getHost: unavailable }),
    memory: new BotMemoryService({ root: path.join(root, 'memory'), runtime: unavailable, embedding: unavailable }),
    model: () => ({ apiFormat: 'openai_chat', model: 'not-used', baseUrl: 'http://127.0.0.1', apiKey: 'not-used' }), onEvent: () => undefined });
  services.push(service); return service;
}

it('seeds the recovered catalogue once, starts with only Bigfish chat, and preserves author edits across restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-bot-bootstrap-')); roots.push(root);
  let service = open(root), state = (await service.handle({ type: 'state' })).snapshot!;
  expect(state.companions.map(item => item.id).sort()).toEqual(BUILTIN_BOT_COMPANIONS.map(item => item.id).sort());
  expect(state.companions).toHaveLength(14); expect(state.conversations).toHaveLength(1);
  expect(state.conversations[0]?.memberIds).toContain(DEFAULT_BOT_COMPANION_ID);
  for (const removed of ['default-companion', 'deepseek-sister', 'deepseek-flash']) expect(state.companions.map(item => item.id)).not.toContain(removed);
  const conversation = state.conversations[0]!;
  await service.handle({ type: 'companion.update', companionId: 'huan-white', name: '幻的自定称呼', persona: '保留作者实际编辑的相处方式。' });
  await service.shutdown(); service = open(root); state = (await service.handle({ type: 'state' })).snapshot!;
  expect(state.companions).toHaveLength(14); expect(state.conversations).toEqual([conversation]);
  expect(state.companions.find(item => item.id === 'huan-white')).toMatchObject({ name: '幻的自定称呼', persona: '保留作者实际编辑的相处方式。' });
});

it('ships the original artwork bytes and the user-provided mini reference behind safe packaged paths', async () => {
  const manifest = JSON.parse(await readFile('public/companion-bot/builtins/legacy-source-manifest.json', 'utf8')) as {
    assets: Array<{ publicPath: string; sha256: string; source: string }>;
  };
  expect(manifest.assets).toHaveLength(30);
  const checksum = async (filename: string) => createHash('sha256').update(await readFile(filename)).digest('hex');
  for (const asset of manifest.assets) {
    expect(await checksum(path.join('public', asset.publicPath))).toBe(asset.sha256);
    expect(await checksum(asset.source)).toBe(asset.sha256);
  }
  for (const builtin of BUILTIN_BOT_COMPANIONS) {
    expect(builtin.persona.length).toBeGreaterThan(500);
    for (const relative of [builtin.portrait.url, builtin.referenceImage]) if (relative) {
      expect(relative).toMatch(/^companion-bot\/builtins\/[a-z0-9-]+\/[a-z0-9-]+\.(png|jpg)$/);
      expect((await readFile(path.join('public', relative))).length).toBeGreaterThan(1000);
    }
  }
  expect(await checksum('public/companion-bot/builtins/dafeiyu/power-save-reference.jpg')).toBe('b1b28d95a2500ccfb1cd16c8ad15e408bba0dcf29994c7d87f881be19bb244c9');
});
