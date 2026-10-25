import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { writeSealedArchive } from '../../src/main/dsh/archive';
import { PackDistributionService, type PackPublishRequest } from '../../src/main/dsh/pack-distribution';
import type { DshMarketplaceNetwork } from '../../src/main/dsh/marketplace';
import type { OperationContext } from '../../src/main/dsh/operations';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-pack-distribution-')); roots.push(rootPath);
  const source = path.join(rootPath, 'data'); await mkdir(path.join(source, 'agents', 'skills', 'fixture'), { recursive: true });
  await writeFile(path.join(source, 'agents', 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: Test\n---\nFixture\n');
  await mkdir(path.join(source, 'runtime-lock')); await writeFile(path.join(source, 'runtime-lock/package-lock.json'), '{}');
  const archivePath = path.join(rootPath, 'fixture.dshpack');
  const network: DshMarketplaceNetwork = { fetch: vi.fn(async () => new Response(null, { status: 404 })), json: vi.fn(), githubCandidates: url => [url] };
  const importArchive = vi.fn(async () => ({ id: 'imported' }));
  const exportArchive = async (_packId: string, file: string, signal: AbortSignal) => writeSealedArchive(source, file, {
    format: 'worldlinebox-dshpack-v2', name: 'Fixture pack', version: '1.0.0', createdAt: '2026-10-12T00:00:00Z',
    runtime: { version: '0.2.0-rc.2', platform: 'win32-x64', adapter: 'node-cli-web-v1', contentSha256: 'f'.repeat(64), sourceSha256: 'a'.repeat(64), npmIntegrity: 'sha512-' + Buffer.alloc(64).toString('base64'), dependencyLockSha256: 'b'.repeat(64), nodeVersion: '24.15.0', npmVersion: '11.12.1', nodeExecutableSha256: 'c'.repeat(64), payloadSha256: 'd'.repeat(64) },
  }, signal);
  const messages: string[] = [];
  const op: OperationContext = { id: 'operation-test', signal: new AbortController().signal, update: vi.fn(async () => undefined), log: async message => { messages.push(message); } };
  return { rootPath, archivePath, network, importArchive, exportArchive, op, messages };
}
describe('Public version-locked pack distribution', () => {
  it('exports digest, public origin metadata and a file lock, and verifies them before network import', async () => {
    const test = await fixture(); const service = new PackDistributionService(test);
    const exported = await service.createDistribution('pack-test', test.archivePath, 'https://example.invalid/fixture.dshpack');
    const bytes = await readFile(test.archivePath); expect(exported.manifest.archive.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await readFile(exported.checksumPath, 'utf8')).toContain(exported.manifest.archive.sha256);
    expect(exported.manifest.lock.files.map(file => file.path)).toEqual(['agents/skills/fixture/SKILL.md', 'runtime-lock/package-lock.json']);
    test.network.fetch = vi.fn(async url => url.endsWith('.manifest.json') ? new Response(JSON.stringify(exported.manifest)) : new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } }));
    expect(await service.importDistribution('https://example.invalid/fixture.dshpack.manifest.json', test.op)).toEqual({ id: 'imported' });
    expect(test.importArchive).toHaveBeenCalledOnce();
  });
  it('refuses tampered bytes and public/archive metadata disagreement before importing anything', async () => {
    const test = await fixture(); const service = new PackDistributionService(test);
    const exported = await service.createDistribution('pack-test', test.archivePath, 'https://example.invalid/fixture.dshpack');
    const bytes = await readFile(test.archivePath); const tampered = Buffer.from(bytes); tampered[20] = (tampered[20] ?? 0) ^ 1;
    test.network.fetch = vi.fn(async url => url.endsWith('.json') ? new Response(JSON.stringify(exported.manifest)) : new Response(new Uint8Array(tampered)));
    await expect(service.importDistribution('https://example.invalid/manifest.json', test.op)).rejects.toThrow('SHA-256'); expect(test.importArchive).not.toHaveBeenCalled();
    test.network.fetch = vi.fn(async url => url.endsWith('.json') ? new Response(JSON.stringify({ ...exported.manifest, name: 'Different title' })) : new Response(new Uint8Array(bytes)));
    await expect(service.importDistribution('https://example.invalid/manifest.json', test.op)).rejects.toThrow('differs from the public'); expect(test.importArchive).not.toHaveBeenCalled();
  });
  it('refuses credential-bearing manifest paths and insecure download URLs', async () => {
    const test = await fixture(); const service = new PackDistributionService(test);
    const exported = await service.createDistribution('pack-test', test.archivePath, 'https://example.invalid/fixture.dshpack');
    const files = [...exported.manifest.lock.files.filter(file => file.path === 'runtime-lock/package-lock.json'), { path: 'home/.credentials.yaml', sha256: 'f'.repeat(64), size: 1 }];
    test.network.fetch = vi.fn(async () => new Response(JSON.stringify({ ...exported.manifest, lock: { files, contentSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), fileCount: files.length, byteLength: files.reduce((total, file) => total + file.size, 0) } })));
    await expect(service.inspectManifest('https://example.invalid/manifest.json')).rejects.toThrow('private or unexpected');
    await expect(service.inspectManifest('http://example.invalid/manifest.json')).rejects.toThrow('HTTPS');
  });
});
describe('Application GitHub publisher', () => {
  it('creates a draft, uploads three checked assets, and publishes only after all uploads succeed', async () => {
    const test = await fixture(); const calls: Array<{ url: string; method: string; body?: unknown }> = []; const repository = 'acme/fixture';
    const request = vi.fn(async (url: string, input: PackPublishRequest) => {
      expect(input.headers?.authorization).toBe('Bearer fixture-token'); expect(new URL(url).hostname).toMatch(/^(api|uploads)\.github\.com$/);
      let body: unknown = input.body;
      if (body instanceof Readable) { const chunks: Buffer[] = []; for await (const chunk of body) chunks.push(Buffer.from(chunk)); body = Buffer.concat(chunks); }
      calls.push({ url, method: input.method, body });
      if (input.method === 'GET') return new Response(null, { status: 404 });
      if (url === `https://api.github.com/repos/${repository}/releases`) { expect(JSON.parse(String(body)).draft).toBe(true); return Response.json({ id: 11, draft: true, assets: [], html_url: `https://github.com/${repository}/releases/tag/v1`, upload_url: `https://uploads.github.com/repos/${repository}/releases/11/assets{?name,label}` }); }
      if (new URL(url).hostname === 'uploads.github.com') { const name = new URL(url).searchParams.get('name')!; const bytes = body as Buffer;
        expect(Number(input.headers?.['content-length'])).toBe(bytes.length); return Response.json({ name, size: bytes.length, browser_download_url: `https://github.com/${repository}/releases/download/v1/${name}` }); }
      return Response.json({ id: 11, draft: false, html_url: `https://github.com/${repository}/releases/tag/v1` });
    });
    const service = new PackDistributionService({ ...test, request });
    const result = await service.publishGithub({ packId: 'pack-test', repository, tag: 'v1', token: 'fixture-token', archivePath: test.archivePath, draft: false }, test.op);
    expect(result.draft).toBe(false); expect(calls.filter(call => new URL(call.url).hostname === 'uploads.github.com')).toHaveLength(3);
    expect(calls.at(-1)?.method).toBe('PATCH'); expect(test.messages.join('\n')).not.toContain('fixture-token'); expect(await readFile(`${test.archivePath}.manifest.json`, 'utf8')).not.toContain('fixture-token');
  });
  it('leaves the draft unpublished after an upload failure and refuses authenticated redirects', async () => {
    const test = await fixture(); let uploads = 0; const methods: string[] = [];
    const request = vi.fn(async (url: string, input: PackPublishRequest) => {
      methods.push(input.method); if (input.method === 'GET') return new Response(null, { status: 404 });
      if (new URL(url).hostname === 'api.github.com') return Response.json({ id: 12, draft: true, assets: [], html_url: 'https://github.com/acme/fixture/releases/tag/v1', upload_url: 'https://uploads.github.com/repos/acme/fixture/releases/12/assets{?name,label}' });
      uploads++; if (uploads === 2) return new Response(null, { status: 500 });
      const chunks: Buffer[] = []; for await (const chunk of input.body as Readable) chunks.push(Buffer.from(chunk)); const name = new URL(url).searchParams.get('name')!;
      return Response.json({ name, size: Buffer.concat(chunks).length, browser_download_url: `https://github.com/acme/fixture/releases/download/v1/${name}` });
    });
    const service = new PackDistributionService({ ...test, request });
    await expect(service.publishGithub({ packId: 'pack-test', repository: 'acme/fixture', tag: 'v1', token: 'fixture-token', archivePath: test.archivePath, draft: false }, test.op)).rejects.toThrow('HTTP 500');
    expect(methods).not.toContain('PATCH');
    const redirected = new PackDistributionService({ ...test, request: async () => new Response(null, { status: 302, headers: { location: 'https://example.invalid/steal' } }) });
    await expect(redirected.publishGithub({ packId: 'pack-test', repository: 'acme/fixture', tag: 'v2', token: 'fixture-token', archivePath: path.join(test.rootPath, 'second.dshpack') }, test.op)).rejects.toThrow('redirects are refused');
  });
});
