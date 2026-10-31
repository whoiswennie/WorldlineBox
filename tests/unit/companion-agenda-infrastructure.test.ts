import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { CompanionArtifactRegistry, type CompanionRegistryStorage } from '../../src/main/companions/artifact-registry';
import { CompanionArtifactRegistryStore } from '../../src/companions/artifact-registry-store';
import { assembleCompanionAssetContext } from '../../src/main/companions/asset-context';
import { companionStorageCommandSchema } from '../../src/shared/companion-storage';
import type { Companion } from '../../src/shared/companions';
import { nodeCompanionConnection } from '../fixtures/node-companion-connection';

const roots: string[] = [], closers: Array<() => void> = [];
afterEach(async () => { for (const close of closers.splice(0)) close(); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('agenda-infrastructure-')) throw new Error('Unexpected fixture root');
  await rm(root, { recursive: true, force: true });
} });
const owner: Companion = { id: 'alice', name: 'Alice', description: '不可改写的创建起点', persona: 'PERSONA_CURRENT_UNCHANGED_42。遇到不确定的事先说明条件。',
  model: '', avatar: 'sister', builtin: false, active: true, proactive: false, createdAt: '2026-10-28T10:00:00.000Z' };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'agenda-infrastructure-')); roots.push(root);
  const { connection } = nodeCompanionConnection(path.join(root, 'registry.sqlite')); closers.push(() => connection.close());
  connection.exec('CREATE TABLE companions(id TEXT PRIMARY KEY,deleted_at TEXT)'); connection.prepare('INSERT INTO companions VALUES(?,NULL)').run(owner.id);
  const backend = new CompanionArtifactRegistryStore(connection); backend.initialize();
  const storage: CompanionRegistryStorage = { request: async command => {
    const response = backend.execute(companionStorageCommandSchema.parse(command)); if (!response) throw new Error('Unexpected registry command'); return response;
  } };
  const profiles = new CompanionAssetProfileStore(root, { registryStorage: storage });
  const initial = await profiles.bootstrap(owner), registry = new CompanionArtifactRegistry(initial.root, owner.id, { registryStorage: storage });
  return { root, profiles, initial, registry };
}

it('publishes canonical self and authorization purposes without changing origin, persona or profile bytes', async () => {
  const f = await fixture(), profileFile = path.join(f.initial.root, 'profile.md'), fragmentsFile = path.join(f.initial.root, 'profile.fragments.json');
  const before = { profile: await readFile(profileFile), fragments: await readFile(fragmentsFile), origin: await f.registry.read({ artifactId: 'origin:creation', consumer: 'audit' }) };
  // Simulate an authenticated older manifest, not an unregistered disk edit.
  const manifest = await f.registry.read({ artifactId: 'host:prompts', consumer: 'host' }), plan = JSON.parse(manifest.text);
  delete plan.purposes.companion_agenda_self; delete plan.purposes.companion_agenda_authorization;
  await f.registry.publish({ artifactId: 'host:prompts', kind: 'host_metadata', relativePath: '提示词/manifest.json',
    expectedRevision: manifest.artifact.contentRevision, content: JSON.stringify(plan, null, 2) + '\n', producer: { kind: 'host', id: 'old-manifest-fixture' },
    sourceRefs: [], dependencyRefs: [], visibility: { scope: 'owner' }, allowedConsumers: ['host', 'audit'], retentionClass: 'current', operationId: 'fixture:old-manifest' });
  await f.profiles.publishAgendaInfrastructure(owner);
  const current = await f.profiles.load(owner.id);
  expect(await readFile(profileFile)).toEqual(before.profile); expect(await readFile(fragmentsFile)).toEqual(before.fragments);
  expect((await f.registry.read({ artifactId: 'origin:creation', consumer: 'audit' })).text).toBe(before.origin.text);
  expect(current.profileRevision).toBe(f.initial.profileRevision); expect(current.profile.persona).toBe(owner.persona);
  const self = assembleCompanionAssetContext({ system: '【稳定人格】\n旧的占位身份\n\n【交互规则】\n本轮合同', user: JSON.stringify({ purpose: 'companion_agenda_self', conversationId: 'world_alice' }) }, current, 'structured');
  expect(self.system).toContain(owner.persona); expect(self.frame.identity).toBe(owner.persona);
  expect(self.frame.roleGuidance).toContain('真实日程事件'); expect(self.frame.profileRevision).toBe(current.profileRevision);
  const authorization = assembleCompanionAssetContext({ system: '只输出来源授权核验结构', user: JSON.stringify({ purpose: 'companion_agenda_authorization' }) }, current, 'structured');
  expect(authorization.frame.identity).toBe(''); expect(authorization.frame.roleGuidance).toContain('当前真人来源');
  expect(authorization.system).not.toContain(owner.persona);
});

it('repeated startup does not publish another infrastructure or prompt revision', async () => {
  const f = await fixture(); await f.profiles.publishAgendaInfrastructure(owner);
  const before = await f.profiles.load(owner.id), marker = await f.registry.get('host:agenda-infrastructure'), version = await f.registry.versionToken();
  await f.profiles.publishAgendaInfrastructure({ ...owner, persona: '不得变成新的创建模板' });
  const after = await f.profiles.load(owner.id);
  expect(after.promptRevision).toBe(before.promptRevision); expect(after.manifestRevision).toBe(before.manifestRevision);
  expect(await f.registry.get('host:agenda-infrastructure')).toEqual(marker); expect(await f.registry.versionToken()).toBe(version);
  expect(after.profile.persona).toBe(owner.persona);
});

it('refuses tampered prompt bytes before its current infrastructure marker can short-circuit validation', async () => {
  const f = await fixture(); await f.profiles.publishAgendaInfrastructure(owner);
  const current = await f.profiles.load(owner.id), module = current.modules.find(module => module.purposes.includes('companion_agenda_self'))!;
  const file = path.join(current.root, ...module.path.split('/')), marker = await f.registry.get('host:agenda-infrastructure');
  await writeFile(file, 'UNREGISTERED_PROMPT_CANARY');
  await expect(f.profiles.publishAgendaInfrastructure(owner)).rejects.toMatchObject({ code: 'CHANGED' });
  expect(await readFile(file, 'utf8')).toBe('UNREGISTERED_PROMPT_CANARY');
  expect(await f.registry.get('host:agenda-infrastructure')).toEqual(marker);
});
