import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { companionArtifactSchema } from '../../src/shared/companion-artifact';
import { registryStorageFixture } from '../fixtures/companion-registry-storage';

it('T-020/T-036 reads one current persona with bounded indexed metadata operations at 100,000 registered notes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-registry-scale-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-registry-scale-')) throw new Error('Unsafe scale fixture cleanup');
  const db = registryStorageFixture(root);
  try {
    const profiles = new CompanionAssetProfileStore(root, { registryStorage: db.storage });
    const initial = await profiles.bootstrap({ id: 'alice', name: 'Alice', description: '', persona: '我会按准确来源核查具体事情。', model: '',
      avatar: 'sister', proactive: false, builtin: false, active: true, createdAt: '2026-10-28T00:00:00Z' });
    const insertCurrent = db.sqlite.prepare('INSERT INTO companion_artifacts(owner_id,artifact_id,kind,relative_path,path_key,state,revision,content_hash,metadata) VALUES(?,?,?,?,?,?,?,?,?)');
    const insertVersion = db.sqlite.prepare('INSERT INTO companion_artifact_versions VALUES(?,?,?,?,?)');
    const insertPublication = db.sqlite.prepare('INSERT INTO companion_artifact_publications VALUES(?,?,?,?,?)');
    const size = 100_000, started = performance.now();
    // Scale fixture populates only legal metadata, with deliberately absent note
    // body files. A profile reader that accidentally reads notes will fail.
    db.sqlite.transaction(() => {
      for (let index = 0; index < size; index++) {
        const id = `scale:${String(index).padStart(6, '0')}`;
        const artifact = companionArtifactSchema.parse({ schema: 'worldlinebox.companion-artifact-v2', artifactId: id, ownerId: 'alice',
          kind: 'episode_memory', producer: { kind: 'host', id: 'scale:fixture' }, relativePath: `记忆/经历/规模/${index}.md`,
          contentRevision: 1, contentHash: 'a'.repeat(64), sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' },
          allowedConsumers: ['episode_recall', 'audit'], retentionClass: 'current', publicationState: 'committed', operationId: 'scale:seed', committedAt: '2026-10-28T00:00:00Z' });
        const metadata = JSON.stringify(artifact);
        insertCurrent.run('alice', id, artifact.kind, artifact.relativePath, artifact.relativePath.toLocaleLowerCase('en-US'), 'committed', 1, artifact.contentHash, metadata);
        insertVersion.run('alice', id, 1, artifact.contentHash, metadata);
        const operationId = `scale:cleaned:${String(index).padStart(6, '0')}`;
        insertPublication.run('alice', operationId, 'revoked', 'a'.repeat(64), JSON.stringify({ ownerId: 'alice', operationId, state: 'revoked',
          authorization: 'system', requestHash: 'a'.repeat(64), reason: '', createdAt: artifact.committedAt, stagesCleanedAt: artifact.committedAt,
          items: [{ next: { ...artifact, operationId }, stage: `.运行/发布/暂存/scale-${index}.bin` }] }));
      }
    })();
    const seedMs = performance.now() - started; db.commands.length = 0; const readStarted = performance.now();
    const current = await profiles.load('alice'), profileReadMs = performance.now() - readStarted;
    expect(current.profileRevision).toBe(initial.profileRevision);
    expect(db.commands.some(command => command.type === 'cognition.registry.page' && !command.kind && !command.prefix && !command.producerId)).toBe(false);
    expect(db.commands.some(command => command.type === 'cognition.registry.read' && (command.artifactId?.startsWith('scale:') || command.artifactIds?.some(id => id.startsWith('scale:'))))).toBe(false);
    expect(db.commands.length).toBeLessThan(500); expect(profileReadMs).toBeLessThan(10000);
    const page = await (await profiles.artifacts('alice')).page({ kind: 'episode_memory', consumer: 'episode_recall', limit: 20 });
    expect(page.items).toHaveLength(20); expect(page.hasMore).toBe(true);
    const registry = await profiles.artifacts('alice'), cleanupStarted = performance.now();
    expect(await registry.pendingPublications({ operationPrefix: 'scale:', includeRevoked: true, limit: 16 })).toEqual([]);
    expect(await registry.pendingPublications({ operationPrefix: 'scale:', uncleanedOnly: true, limit: 16 })).toEqual([]);
    const cleanupDebtMs = performance.now() - cleanupStarted;
    const cleanupPlan = db.sqlite.prepare("EXPLAIN QUERY PLAN SELECT operation_id FROM companion_artifact_publications WHERE owner_id=? AND state='revoked' AND json_extract(data,'$.stagesCleanedAt') IS NULL ORDER BY operation_id LIMIT 16").all('alice') as Array<{ detail: string }>;
    expect(cleanupPlan.some(entry => entry.detail.includes('companion_artifact_uncleaned'))).toBe(true); expect(cleanupDebtMs).toBeLessThan(3000);
    const count = db.sqlite.prepare('SELECT COUNT(*) AS count FROM companion_artifacts').get() as { count: number };
    const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'companion_artifact%'").all();
    process.stdout.write(JSON.stringify({ test: 'T-036', fixture: 'synthetic typed metadata; no note body files and no model', registeredArtifacts: count.count,
      seededNotes: size, cleanedRevokedPublications: size, seedMs: Math.round(seedMs), profileReadMs: Math.round(profileReadMs), profileMetadataCommands: db.commands.length,
      cleanupDebtMs: Math.round(cleanupDebtMs), cleanupUsesPartialIndex: true,
      registryTables: tables, bodyFallbackUsed: false, fullOwnerMetadataScan: false }) + '\n');
  } finally { db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
