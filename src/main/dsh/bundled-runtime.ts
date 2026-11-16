import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import release from '../../../resources/dsh-runtime-release.json';
import { dshRuntimeSchema, type DshRuntime } from '../../shared/dsh-launcher';
import { hashFile, readJson } from './files';
import { validateOfficialNodeProgram } from './node-runtime-service';

export const bundledDshRelease = release;
export const bundledDshArchive = 'runtime.7z';
const resourceManifest = z.strictObject({
  runtime: dshRuntimeSchema,
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export function matchesBundledDshRelease(runtime: Pick<DshRuntime, 'version' | 'sourceSha256' | 'npmIntegrity'>): boolean {
  return runtime.version === release.version && runtime.sourceSha256 === release.sourceSha256
    && runtime.npmIntegrity === release.integrity;
}

export async function readBundledDshResource(directory: string, signal?: AbortSignal) {
  const manifest = resourceManifest.parse(await readJson(path.join(directory, 'manifest.json')));
  const { runtime, archiveSha256 } = manifest;
  if (!matchesBundledDshRelease(runtime)
    || runtime.id !== `runtime-${runtime.contentSha256.slice(0, 24)}`) {
    throw new Error('Bundled DSH runtime differs from the pinned official release.');
  }
  const archive = path.join(directory, bundledDshArchive);
  if (await hashFile(archive, signal) !== archiveSha256) throw new Error('Bundled DSH archive failed SHA-256 verification.');
  return { archive, runtime };
}

export async function validateBundledDshProgram(program: string, signal?: AbortSignal) {
  const receipt = await validateOfficialNodeProgram(program, signal);
  if (!matchesBundledDshRelease(receipt)) {
    throw new Error('DSH program differs from the pinned official release.');
  }
  return receipt;
}

export async function runBundledDshArchiver(executable: string, args: string[], cwd: string, signal?: AbortSignal) {
  await promisify(execFile)(executable, args, { cwd, signal, windowsHide: true });
}
