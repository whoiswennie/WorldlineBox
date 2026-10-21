import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { generateCompanionText } from '../../src/main/companions/model';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

const enabled = process.env.WORLDLINEBOX_CONTENT_EVALUATION === '1';
it.skipIf(!enabled)('verifies an isolated real global chat connection without exposing or persisting the key', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-content-evaluation-'));
  try {
    const config = await realGlobalChatConfig(root);
    const started = performance.now();
    const text = await generateCompanionText({ system: '你是验收连接探针。只回答READY，不调用工具。', user: '这是隔离验收，只回答READY。' }, config, undefined, { timeoutMs: 60000 });
    const output = path.resolve('artifacts/vcp-validation/content-real-chat-connection.json'); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ at: new Date().toISOString(), apiFormat: config.apiFormat, model: config.model, response: text, elapsedMs: performance.now() - started, plaintextApiKeyPersisted: false, temporaryProfileCopiedOnlyEncryptedOsCryptMetadata: true, realUserDataModified: false }, null, 2));
    expect(text).toContain('READY');
  } finally { await removeOwnedDirectory(root); }
}, 90000);
