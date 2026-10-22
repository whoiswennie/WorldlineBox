import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createNativeAcceptanceBroker } from '../helpers/companion-dsh-native-broker';
import { installedDshAcceptanceProgram } from '../helpers/companion-dsh-real-route';

it.skipIf(process.platform !== 'win32' || !existsSync(path.join(process.env.APPDATA ?? '', 'WorldlineBox/dsh-launcher/runtimes.json')))(
  'rotates the real selected native host after thirty-two leases and prepares a warm replacement without model requests', async () => {
    let requests = 0, closing = false, wasReady = false;
    let replacement: Promise<unknown> | undefined;
    const server = createServer((_request, response) => { requests++; response.writeHead(500).end('Models are forbidden.'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Probe endpoint did not bind.');
    const test = await createNativeAcceptanceBroker({ program: await installedDshAcceptanceProgram(), apiKey: 'standby-no-real-key', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${address.port}/v1`,
      onWorkerReadyChanged: (_instanceId, ready) => {
        if (!ready && wasReady && !closing) {
          replacement = new Promise<void>(resolve => setTimeout(resolve, 300)).then(() => test.broker.discover('acceptance'));
        }
        wasReady = ready;
      } });
    test.broker.setStandbyInstance('acceptance');
    try {
      const pids = new Set<number>(), timings: number[] = [];
      for (let lease = 0; lease < 32; lease++) {
        const started = performance.now(), capabilities = await test.broker.discover('acceptance');
        timings.push(Math.round(performance.now() - started)); expect(capabilities.tools.some(tool => tool.name === 'read')).toBe(true);
        pids.add(test.broker.state()[0]!.pid!);
      }
      expect(pids.size).toBe(1); await expect.poll(() => !!replacement).toBe(true); await replacement;
      const replacementPid = test.broker.state()[0]!.pid!; expect(pids.has(replacementPid)).toBe(false);
      const started = performance.now(); await test.broker.discover('acceptance'); const warmAfterRotationMs = Math.round(performance.now() - started);
      expect(test.broker.state()[0]!.pid).toBe(replacementPid); expect(warmAfterRotationMs).toBeLessThan(2000); expect(requests).toBe(0);
      await mkdir(path.resolve('.tools/test-output'), { recursive: true });
      await writeFile(path.resolve('.tools/test-output/companion-dsh-selected-standby-native.json'), JSON.stringify({ status: 'passed', runtimeVersion: '0.2.1-rc.2', originalPid: [...pids][0], replacementPid,
        leasesBeforeRetirement: 32, warmAfterRotationMs, firstColdMs: timings[0], previousWarmMs: timings.slice(1), modelRequests: requests,
        transport: 'production Broker and official CLI; thin stdio carrier; readiness callback follows launcher 300ms replenishment policy' }, null, 2));
    } finally { closing = true; await replacement?.catch(() => undefined); await test.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 120000);
