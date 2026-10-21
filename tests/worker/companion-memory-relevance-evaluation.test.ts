import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { vcpMemoryNotebookFolder, type VcpMemoryNote } from '../../src/main/vcp-memory/contracts';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const enabled = process.env.WORLDLINEBOX_CONTENT_RELEVANCE_EVALUATION === '1';
it.skipIf(!enabled)('records original RAG River/Truncate scores for real Chinese journals and relevant/unrelated local Gemma queries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-content-relevance-'));
  const native = await realMemoryRuntime(root);
  try {
    const source = JSON.parse(await readFile(path.resolve('artifacts/vcp-validation/content-three-companions-before-relevance-fix.json'), 'utf8')) as { phases: Array<{ journals: Array<{ owner: string; notes: VcpMemoryNote[] }> }> };
    const notes = source.phases.at(-1)!.journals.find(owner => owner.owner === 'lin')!.notes.map(note => ({ ...note, author: 'WorldlineBox', occurredAt: '2026-10-22T00:00:00+08:00' }));
    const scope = { scopeId: 'real-content-relevance-parameter-observation' }; await native.client.replace(scope, notes);
    const books = [...new Set(notes.map(note => vcpMemoryNotebookFolder(note.diaryName)))].join('|'), results = [];
    for (const [kind, query] of [['related', '植物交流会约定何时去？谁带蓝色雨伞？'], ['related', '我平时和晚上各有什么咖啡习惯？'], ['related', '旅行箱放在哪个位置？'],
      ['unrelated', '解释木星为什么有大红斑，只讨论天文学。'], ['unrelated', '怎样求解二元一次方程组？'], ['unrelated', '早上好呀，哈哈。']]) {
      const nativeHits = await native.client.search(scope, { text: query!, topK: 10 });
      const outputs = [];
      for (const threshold of [0, .35, .45, .55, .65]) {
        const marker = `[[${books}日记本::RiverMemo${threshold ? `::Truncate${threshold}` : ''}]]`;
        const rag = await native.client.preprocess(scope, [{ role: 'system', content: marker }, { role: 'user', content: query! }]);
        outputs.push({ threshold, content: rag.messages[0]?.content, events: rag.events });
      }
      results.push({ kind, query, nativeHits: nativeHits.results.map(hit => ({ id: hit.id, score: hit.score, content: hit.content })), outputs });
    }
    const output = path.resolve('artifacts/vcp-validation/content-relevance-calibration.json'); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ at: new Date().toISOString(), profile: native.profile, results, limitation: 'Parameter observation over actual synthetic-chat journals, not a universal similarity threshold or public quality benchmark.' }, null, 2));
    expect(results).toHaveLength(6);
  } finally { await native.close(); await removeOwnedDirectory(root); }
}, 180000);
