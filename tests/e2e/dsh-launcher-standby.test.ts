import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { verifyActualLauncherStandby } from './fixtures/dsh-launcher-standby';

test('production Main keeps the selected native host ready, rotates it, and stops after a failed replacement', async () => {
  test.setTimeout(180000);
  const input = process.env.WORLDLINEBOX_LAUNCHER_STANDBY_PROFILE;
  test.skip(!input, 'Requires the owned admitted temporary runtime from the full launcher acceptance.');
  const root = await realpath(input!);
  expect(path.dirname(root)).toBe(await realpath(tmpdir())); expect(path.basename(root)).toMatch(/^worldlinebox-launcher-warm-/);
  const result = await verifyActualLauncherStandby(root, path.join(root, 'profile'), true);
  await mkdir(path.resolve('.tools/test-output'), { recursive: true });
  await writeFile(path.resolve('.tools/test-output/companion-dsh-launcher-standby-final.json'), JSON.stringify({ status: 'passed', modelTurnsSubmitted: 0,
    nativeMainLauncher: true, backendMocked: false, ...result }, null, 2));
});
