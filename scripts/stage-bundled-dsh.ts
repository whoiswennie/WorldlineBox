import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dshRuntimeSchema, type DshRuntime } from '../src/shared/dsh-launcher';
import {
  bundledDshArchive, bundledDshRelease, readBundledDshResource, runBundledDshArchiver, validateBundledDshProgram,
} from '../src/main/dsh/bundled-runtime';
import { hashFile, inventoryTree, readJson } from '../src/main/dsh/files';
import { RuntimeService } from '../src/main/dsh/runtime-service';
import toolLock from '../resources/portable-tools/tool-lock.json';

async function acquire(root: string, cache: string, signal: AbortSignal): Promise<DshRuntime> {
  const { node, npm } = toolLock.versions;
  const portableNode = path.join(root, 'resources', 'portable-tools', 'win32-x64', 'node');
  const service = new RuntimeService({
    rootPath: cache,
    onChanged: () => undefined,
    nodeTools: async () => ({
      nodeExecutable: path.join(portableNode, 'node.exe'),
      npmCli: path.join(portableNode, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      nodeVersion: node,
      npmVersion: npm,
    }),
    nodeInstallNetwork: async () => ({ env: process.env, registry: 'https://registry.npmjs.org' }),
  });
  try {
    await service.init();
    return service.list().find(item => item.version === bundledDshRelease.version
      && item.sourceSha256 === bundledDshRelease.sourceSha256 && item.npmIntegrity === bundledDshRelease.integrity)
      ?? await service.installNode(bundledDshRelease, {
        id: 'bundled-dsh', signal,
        update: async phase => { console.log(phase); },
        log: async () => undefined,
      });
  } finally {
    await service.close();
  }
}

export async function stageBundledDsh(root: string, verifyDirectory?: string): Promise<void> {
  const signal = AbortSignal.timeout(45 * 60_000);
  if (verifyDirectory) {
    await readBundledDshResource(path.resolve(verifyDirectory), signal);
    console.log(`Bundled DSH ${bundledDshRelease.version} verified.`);
    return;
  }
  const bundleRoot = path.join(root, '.tools', 'dsh-runtime-release');
  const target = path.join(bundleRoot, 'dsh-runtime');
  if (await readBundledDshResource(target, signal).then(() => true, () => false)) return;

  await mkdir(bundleRoot, { recursive: true });
  const cache = path.join(bundleRoot, 'cache');
  const source = process.env.WORLDLINEBOX_DSH_BUNDLED_ARTIFACT;
  const selected = source ? undefined : await acquire(root, cache, signal);
  const artifact = source ? path.resolve(source) : path.join(cache, 'runtimes', selected!.id);
  const runtime = dshRuntimeSchema.parse(await readJson(path.join(artifact, 'artifact.json')));
  const program = path.join(artifact, 'program');
  const receipt = await validateBundledDshProgram(program, signal);
  const seal = await inventoryTree(program, signal);
  if (runtime.contentSha256 !== seal.contentSha256 || runtime.fileCount !== seal.fileCount
    || runtime.byteLength !== seal.byteLength || runtime.nodeVersion !== receipt.nodeVersion
    || runtime.npmVersion !== receipt.npmVersion || runtime.dependencyLockSha256 !== receipt.dependencyLockSha256) {
    throw new Error('Bundled DSH source failed runtime verification.');
  }

  const staging = await mkdtemp(path.join(bundleRoot, 'stage-'));
  try {
    const archive = path.join(staging, bundledDshArchive);
    const archiver = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
    await runBundledDshArchiver(archiver, ['a', '-t7z', '-mx=5', '-mmt=4', '-bso0', archive, 'program'], artifact, signal);
    const archiveSha256 = await hashFile(archive, signal);
    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ runtime, archiveSha256 }, null, 2));
    await readBundledDshResource(staging, signal);
    await mkdir(target, { recursive: true });
    await rename(archive, path.join(target, bundledDshArchive));
    await rename(path.join(staging, 'manifest.json'), path.join(target, 'manifest.json'));
    console.log(`Bundled DSH ${runtime.version} staged at ${target}.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
