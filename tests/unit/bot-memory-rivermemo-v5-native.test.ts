import { expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const release = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const bundleDirectory = path.resolve('resources/embedding-models');
const available = existsSync(path.join(release, 'lib/runtime.cjs')) && existsSync(nodePath)
  && existsSync(path.join(bundleDirectory, 'runtime-cpu/llama-server.exe'));

it.skipIf(!available)('recalls the first indexed diary immediately, preserves the OneRing turn receipt and uses trained V5 after cold start', async () => {
  const fromRelease = createRequire(path.join(release, 'package.json'));
  const model = await fromRelease('./lib/local-embedding.cjs').startLocalEmbedding({ bundleDirectory, backend: 'cpu' });
  const home = await mkdtemp(path.join(os.tmpdir(), 'worldline-v5-native-'));
  const worker = fromRelease('./lib/client.cjs').createSession({ nodePath, home, env: {
    WORLDLINEBOX_VCP_MANAGED: '1', EMBEDDING_MODEL: model.model, EmbeddingModelSig: model.modelSignature,
    EMBEDDING_API_URL: model.documentUrl, EMBEDDING_QUERY_API_URL: model.queryUrl, EMBEDDING_API_KEY: model.apiKey,
  } });
  const call = (operation: string, payload: object) => worker.request(operation, payload, { timeoutMs: 120000 });
  const messages = [
    { role: 'system', content: '<---VCP记忆思维区Start--->\n[[Companion日记本::Group::Time::RiverMemo]]\n[[VCPTimeLine::Companion]]\n<---VCP记忆思维区End--->\n[[OneRing::owner::WorldlineBox]]\n[[OneRingMemo::owner]]\n[[ContextFoldingV2]]' },
    { role: 'user', content: '我的备用钥匙在哪里？' },
  ];
  const preprocess = () => call('preprocess', { messages, options: { variables: false, sync: false } });
  const writeDiary = async (sourceEventId: string, content: string, tags: string) => {
    const { id } = await call('bot.remember', { sourceEventId, sourceMessageIds: ['msg-' + sourceEventId], hostAuthor: '[值班]星河', content, tags });
    await call('bot.sync', { id });
    return call('bot.note.read', { id }) as Promise<{ id: string; checksum: string }>;
  };
  try {
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ VECTORDB_DIMENSION: model.dimension,
      WhitelistEmbeddingModel: model.model, EmbeddingModelSig: model.modelSignature, LOCAL_EMBEDDING_ENABLED: false,
      TDB_KNOWLEDGE_ENABLED: true, ONERING_ASYNC_ONLY_MODE: false, KNOWLEDGEBASE_BATCH_WINDOW_MS: 25 }));
    const empty = await preprocess();
    expect(JSON.stringify(empty.messages)).toContain('没有找到直接相关的记忆片段');
    const keys = await writeDiary('keys', '备用钥匙装在黄色信封，藏在卧室壁橱的最上层。', '钥匙,卧室,壁橱');
    const first = await preprocess();
    expect(JSON.stringify(first.messages)).toContain('卧室壁橱');
    expect(first.metadata.oneRing).toMatchObject({ agentName: 'owner', turnId: expect.any(String) });
    await call('response', { messages: first.messages, metadata: first.metadata, text: '在壁橱里。', completed: true });
    const active = await call('search', { query: '备用钥匙', options: { folder: 'Companion', sync: false, k: 2 } });
    expect(JSON.stringify(active)).toContain('卧室壁橱');
    const coldHit = await call('retrieve', { query: '备用钥匙', diaries: ['Companion'], k: 1, managedSources: true });
    expect(coldHit.results[0]).toMatchObject({ sourceEventIds: ['keys'], text: expect.stringContaining('卧室壁橱') });
    expect(coldHit.results[0].sourceMessageIds).toEqual(['msg-keys']);
    const associate = (sources: Array<{ id: string; checksum: string }>, revision = '0') => call('bot.diaries.associate', {
      sources: sources.map(({ id, checksum }) => ({ id, checksum })), expectedSourceRevision: revision });
    expect((await associate([keys])).items).toEqual([]);

    const backups = await writeDiary('backups', '生产数据库每小时执行异地备份，断电后使用最新快照恢复。', '数据库,备份,恢复,快照,容灾,持久化,事务,运维');
    const plants = await writeDiary('plants', '会议室绿植春季换盆，冬季控制浇水频率。', '园艺,浇水,绿植,花盆,阳光,土壤');
    const drills = await writeDiary('drills', '客户演练需要记录变更历史并验证日志归档完整。', '运维,日志,容灾,演练,恢复,验证,备份');
    await call('invoke', { target: 'knowledge', method: 'requestActiveFullTraining' });
    await expect.poll(async () => (await call('invoke', { target: 'training', method: 'getTrainingStatus' })).status,
      { timeout: 60000, interval: 250 }).toBe('completed');
    const trained = await call('retrieve', { query: '断电后如何恢复数据库？', diaries: ['Companion'], k: 3, fallback: 'none' });
    expect(trained.meta).toMatchObject({ engine: 'rivermemo', nativeJointQueryUsed: true });
    expect(JSON.stringify(trained.results)).toContain('异地备份');
    const linked = await call('retrieve', { query: '断电后如何恢复数据库？', diaries: ['Companion'], k: 3, managedSources: true });
    expect(linked.results).toContainEqual(expect.objectContaining({ sourceEventIds: ['backups'], text: expect.stringContaining('异地备份') }));
    expect(JSON.stringify(linked.results)).not.toContain(home);

    const dreamWork = (action: string, args: object) => call('bot.maintenance.work', { kind: 'dream', jobId: 'native-dream', action, ...args });
    const seeds = [keys, backups], notes = [keys, backups, plants, drills];
    const batch = await dreamWork('claim', { limit: 2 });
    expect(batch.items).toEqual(seeds.map(({ id, checksum }) => ({ id, checksum })));
    const wave = await call('bot.dream.recall', { expectedSourceRevision: batch.revision,
      sources: batch.items.map(({ id, checksum }: { id: string; checksum: string }) => ({ id, expectedChecksum: checksum })) });
    type DreamHit = { id: string; checksum: string; fullPath: string; retrievalEngine?: string; score?: number };
    const dreamGroups = wave.groups as Record<string, DreamHit[]>;
    expect(wave).toMatchObject({ engine: 'DreamWaveEngine', namespace: 'Companion', examined: 2, sourceRevision: '0' });
    expect(dreamGroups['recent.seeds']!.map(hit => hit.id).sort()).toEqual(seeds.map(note => note.id).sort());
    const associations = [...dreamGroups['recent.resonanceL1']!, ...dreamGroups['recent.cascadeL2']!];
    expect(associations.some(hit => [plants.id, drills.id].includes(hit.id) && hit.retrievalEngine === 'rivermemo' && Number.isFinite(hit.score))).toBe(true);
    for (const hit of Object.values(dreamGroups).flat()) {
      expect(hit.fullPath).toMatch(/^Companion\/[^/]+$/u);
      const bytes = await readFile(path.join(home, 'dailynote', hit.fullPath));
      expect(bytes.toString('utf8')).toMatch(/^\[\d{4}-\d{2}-\d{2}\] - \[值班\]星河\n\[\d{2}:\d{2}\]\n[\s\S]+\nTag: .+/u);
      expect(createHash('md5').update(bytes).digest('hex')).toBe(hit.checksum);
      expect(notes.find(note => note.id === hit.id)?.checksum).toBe(hit.checksum);
      expect(wave.dreamPrompt).toContain(hit.id);
    }
    const template = await readFile(path.join(release, 'upstream/toolbox/Plugin/AgentDream/dreampost.txt'), 'utf8');
    for (const literal of template.split(/\{\{\w+\}\}/u).filter(Boolean)) expect(wave.dreamPrompt).toContain(literal);
    expect(wave.dreamPrompt).toContain('（共振桥梁）');
    expect(wave.dreamPrompt).not.toMatch(/\{\{\w+\}\}/u);
    const timeline = await call('invoke', { target: 'timeline', method: 'discoverMemories', args: ['Companion'] });
    expect(Object.values(timeline).flat()).toContainEqual(expect.stringContaining('[值班]星河'));
    const context = await dreamWork('associate', { retrieval: wave });
    const extra = [...new Set(associations.map(hit => hit.id).filter(id => id === plants.id || id === drills.id))].sort();
    expect(context.items.map(({ id }: { id: string }) => id).sort()).toEqual(extra);
    for (const item of context.items) {
      const read = await call('bot.note.read', { id: item.id });
      expect(read).toMatchObject({ checksum: item.checksum, indexState: 'indexed', content: expect.stringMatching(/绿植|演练/u) });
    }
    await dreamWork('complete', { sources: [...batch.items, ...context.items] });
    const next = await dreamWork('claim', { jobId: 'next-native-dream', limit: 24 });
    expect(next.items.map(({ id }: { id: string }) => id).sort()).toEqual([plants.id, drills.id].sort());
    await dreamWork('complete', { jobId: 'next-native-dream', sources: next.items });
    expect((await dreamWork('stats', {})).ready).toBe(0);
    const sampled = await call('bot.dream.recall', { expectedSourceRevision: batch.revision });
    expect(sampled.examined).toBe(4);
    expect(sampled.groups['recent.seeds']).toHaveLength(3);
    for (const hit of sampled.groups['recent.seeds']) {
      expect(sampled.sources).toContainEqual({ id: hit.id, checksum: hit.checksum, role: 'seed' });
      expect(notes.find(note => note.id === hit.id)?.checksum).toBe(hit.checksum);
    }
    expect(sampled.dreamPrompt).toMatch(/\[系统时间\]: [一二三四五六七八九十]+月\d+日 [晨午日夜]/u);

    const organization = await call('bot.maintenance.work', { action: 'claim', kind: 'organize', jobId: 'related-diaries', limit: 2 });
    // This is the untouched upstream command, running against precisely the
    // same Trivium handle, embedding profile and files as the managed API.
    const managerFile = 'Plugin/DailyNoteManager/daily-note-manager.js';
    const manifest = JSON.parse(await readFile(path.join(release, 'upstream/manifest.json'), 'utf8'));
    const pinnedManager = await readFile(path.join(release, 'upstream/toolbox', managerFile));
    const expected = manifest.files.find((entry: { project: string; path: string }) => entry.project === 'toolbox' && entry.path === managerFile);
    expect(createHash('sha256').update(pinnedManager).digest('hex')).toBe(expected.sha256);
    const checkout = path.resolve('../vcp/VCPToolBox');
    if (existsSync(path.join(checkout, '.git'))) {
      const officialBlob = execFileSync('git', ['-C', checkout, 'show', manifest.sources.toolbox.commit + ':' + managerFile], { windowsHide: true });
      expect(pinnedManager.equals(officialBlob)).toBe(true);
    }
    const files = new Map<string, string>();
    for (const file of await readdir(path.join(home, 'dailynote', 'Companion'), { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const bytes = await readFile(path.join(home, 'dailynote', 'Companion', file.name));
      const note = notes.find(note => note.checksum === createHash('md5').update(bytes).digest('hex'));
      if (note) files.set('Companion/' + file.name, note.id);
    }
    const urls = seeds.map(seed => [...files].find(([, id]) => id === seed.id)![0]);
    const official = await call('tool', { name: 'DailyNoteManager', args: { command: 'associate', url: urls.join('\n'), range: 'Companion' } });
    expect(official.status).toBe('success');
    const originalHits = [...String(official.result).matchAll(/^📄 \[(.+)\] \(相似度: (-?[\d.]+)\)$/gmu)]
      .map(([, file, score]) => ({ id: files.get(file!), score }));
    expect(originalHits.length).toBeGreaterThan(0);
    const related = await associate(organization.items, organization.revision);
    expect(related.items.map((item: { id: string; score: number }) => ({ id: item.id, score: item.score.toFixed(4) }))).toEqual(originalHits);
    const day = path.basename(urls[0]!).slice(0, 10), inputs = { sources: organization.items, expectedSourceRevision: organization.revision };
    const dated = await call('bot.diaries.associate', { ...inputs, fromDate: day, toDate: day });
    expect(dated.items.map((item: { id: string; score: number; diaryDate: string }) => ({ id: item.id, score: item.score.toFixed(4), day: item.diaryDate })))
      .toEqual(originalHits.map(item => ({ ...item, day })));
    await expect(call('bot.diaries.associate', { ...inputs, toDate: '1989-12-31' })).rejects.toMatchObject({ code: 'MEMORY_NOTE_UNAVAILABLE' });
    expect(related).toMatchObject({ engine: 'DailyNoteManager.Associate', sourceRevision: organization.revision,
      queries: seeds.map(seed => expect.objectContaining({ seedId: seed.id, nativeJointQueryUsed: true, totalChunksFound: expect.any(Number) })) });
    expect(related.items).toContainEqual(expect.objectContaining({ id: drills.id, checksum: drills.checksum, seedIds: expect.arrayContaining([backups.id]),
      sourceEventId: 'drills', sourceMessageIds: ['msg-drills'], score: expect.any(Number) }));
    expect(related.items.map((item: { id: string }) => item.id)).not.toContain(keys.id);
    expect(JSON.stringify(related)).not.toMatch(/(?:Companion[\\/]|\.txt|file:\/\/)/u);
    const contextRefs = await call('bot.maintenance.work', { action: 'associate', kind: 'organize', jobId: 'related-diaries', retrieval: related });
    expect(contextRefs.items).toContainEqual({ id: drills.id, checksum: drills.checksum });
    await call('bot.maintenance.work', { action: 'complete', kind: 'organize', jobId: 'related-diaries', sources: [...organization.items, ...contextRefs.items] });
    expect((await call('bot.maintenance.work', { action: 'stats', kind: 'organize' })).ready).toBe(2);
    await expect(associate([{ id: backups.id, checksum: '0'.repeat(32) }])).rejects.toMatchObject({ code: 'MEMORY_CONFLICT' });
    await expect(associate([{ id: '0'.repeat(64), checksum: backups.checksum }])).rejects.toMatchObject({ code: 'MEMORY_NOTE_UNAVAILABLE' });
    await expect(associate([backups], '9')).rejects.toMatchObject({ code: 'MEMORY_SOURCE_WITHDRAWN' });

    await call('knowledge.put', { library: '资料', fileName: '说明.md', content: '容灾演练开始前要检查快照。' });
    await call('sync', {});
    const tql = (query: string) => call('cold.tqlRead', { library: '资料', query });
    const rows = await tql('MATCH (n) RETURN n.id LIMIT 5');
    expect(rows.length).toBeGreaterThan(0);
    await expect(tql('CREATE (a {name: "unsupported"})')).rejects.toThrow();
    const pelorus = await call('cold.pelorusSearch', { library: '资料', query: '演练前需要准备什么？' });
    expect(pelorus.hits.length).toBeGreaterThan(0);

    const groups = (command: string, args = {}) => call('tool', { name: 'SemanticGroupEditor', args: { command, ...args } });
    await groups('UpdateGroups', { groupname: '收纳', groupwords: '壁橱,钥匙' });
    await groups('SetWeight', { groupname: '收纳', weight: 2 });
    expect((await groups('QueryGroups')).result).toContain('权重:2');
    const grouped = await preprocess();
    expect(JSON.stringify(grouped.messages)).toContain('收纳');
    await call('bot.sources.withdraw', { companionId: 'owner', sourceEventIds: ['keys'] });
    expect((await groups('QueryGroups')).result).not.toContain('壁橱');
    expect(JSON.stringify((await preprocess()).messages)).not.toContain('卧室壁橱');

    await writeFile(path.join(home, 'dailynote/Companion/unmanaged.txt'), '未登记的用户文件。\nTag: 未登记');
    await call('sync', {});
    await expect(call('retrieve', { query: '未登记的用户文件', diaries: ['Companion'], engine: 'knn', k: 8, managedSources: true }))
      .rejects.toMatchObject({ code: 'MEMORY_PROVENANCE_UNAVAILABLE' });

    const organize = { operationId: 'signed-organize', sourceEventId: 'signed-organize', content: '演练完成后维护会议室绿植。', tags: '演练,绿植',
      sources: [plants, drills].map(({ id, checksum }) => ({ id, expectedChecksum: checksum })) };
    const merged = await call('bot.organize', { ...organize, hostAuthor: '月舟' });
    expect(merged.state).toBe('indexed');
    const folder = path.join(home, 'dailynote/Companion');
    const filename = (await readdir(folder)).find(name => name.includes(merged.id))!;
    const body = await readFile(path.join(folder, filename), 'utf8');
    expect(body).toMatch(/^\[\d{4}-\d{2}-\d{2}\] - 月舟\n\[\d{2}:\d{2}\]\n/u);
    expect(body).toContain(plants.id); expect(body).toContain(drills.id);
    const replay = await call('bot.organize', { ...organize, hostAuthor: '更名后的伙伴' });
    expect(replay.id).toBe(merged.id); expect(replay.checksum).toBe(merged.checksum);
    const track = await call('bot.update', { operationId: 'edit-signed', sourceEventId: 'edit-signed', id: merged.id, expectedChecksum: merged.checksum,
      content: '演练时间已更正。状态注记：恢复步骤依据数据库异地快照。', evidenceSources: [{ id: backups.id, expectedChecksum: backups.checksum }] });
    expect(track).toMatchObject({ state: 'indexed', id: merged.id });
    const updated = await readFile(path.join(folder, filename), 'utf8');
    expect(updated.split('\n').slice(0, 2)).toEqual(body.split('\n').slice(0, 2));
    const inventory = await call('bot.catalog', { indexedOnly: true, limit: 20 });
    expect(inventory.items.map((note: { id: string }) => note.id).sort()).toEqual([backups.id, merged.id].sort());
    await call('bot.sources.withdraw', { companionId: 'owner', sourceEventIds: ['backups'] });
    expect((await call('bot.catalog', { indexedOnly: true, limit: 20 })).items).toEqual([]);
    await expect(call('bot.note.read', { id: merged.id })).rejects.toMatchObject({ code: 'MEMORY_NOTE_UNAVAILABLE' });
  } finally {
    try { await worker.close(); } finally {
      await model.close();
      if (path.dirname(home) === path.resolve(os.tmpdir()) && path.basename(home).startsWith('worldline-v5-native-')) {
        await rm(home, { recursive: true, force: true });
      }
    }
  }
}, 180000);
