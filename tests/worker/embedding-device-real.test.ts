import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EmbeddingDeviceCapabilityService } from '../../src/main/embedding-device-capability';
import { startLlamaEmbeddingSession } from '../../src/main/embedding-llama-session';
import { embeddingDeviceCapabilitySchema } from '../../src/shared/embedding/device-capability';

async function removeEvaluationProfile(root: string): Promise<void> {
  const actual = path.resolve(root), temporaryRoot = path.resolve(tmpdir());
  if (path.dirname(actual) !== temporaryRoot || !path.basename(actual).startsWith('worldlinebox-device-evaluation-')) throw new Error('Unexpected evaluation cleanup path.');
  await rm(actual, { recursive: true, force: true });
}

describe.skipIf(process.env.WORLDLINEBOX_DEVICE_EVALUATION !== '1')('actual bundled device self-test', () => {
  it('records real CPU/GPU/RAM and short native text/image latency without touching user settings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-device-evaluation-'));
    let sessionsStarted = 0, sessionsClosed = 0;
    const service = new EmbeddingDeviceCapabilityService({ userDataPath: root, bundleDirectory: path.resolve('resources/embedding-models'),
      koffiPath: createRequire(import.meta.url).resolve('koffi'), startSession: async input => {
        const session = await startLlamaEmbeddingSession(input); sessionsStarted++;
        return { ...session, close: async () => { await session.close(); sessionsClosed++; } };
      } });
    try {
      const initial = await service.status();
      expect(initial.state).toBe('unchecked'); expect(sessionsStarted).toBe(0);
      const result = await service.test({ force: true });
      embeddingDeviceCapabilitySchema.parse(result);
      await service.close();
      const report = { generatedAt: new Date().toISOString(), case: 'fixed short Chinese/English text and 224px image', userDataModified: false,
        isolatedTemporaryProfile: true, sessionsStarted, sessionsClosed, capability: result,
        scope: 'A routine text/image capability sample; it does not assert large audio/video performance or model quality.' };
      await mkdir(path.resolve('artifacts/vcp-validation'), { recursive: true });
      await writeFile(path.resolve('artifacts/vcp-validation/embedding-device-real.json'), JSON.stringify(report, null, 2), 'utf8');
      expect(['supported', 'unsupported']).toContain(result.state);
      expect(result.metrics).toBeDefined(); expect(result.hardware?.cpuModel).toBeTruthy();
      expect(result.hardware?.totalMemoryBytes).toBeGreaterThan(0); expect(sessionsStarted).toBe(1); expect(sessionsClosed).toBe(1);
      const cached = JSON.parse(await readFile(path.join(root, 'embedding-models/device-capability-v1.json'), 'utf8'));
      expect(cached.fingerprint).toBe(result.fingerprint);
    } finally {
      await service.close();
      await removeEvaluationProfile(root);
    }
  });
});
