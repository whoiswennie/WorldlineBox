import { expect, it } from 'vitest';
import { buildBotMemoryEvidence, readBotMemoryCitation } from '../../src/main/companion-bot/memory-evidence';

const event = (results: unknown[]) => ({ type: 'RAG_RETRIEVAL_DETAILS', dbName: 'Companion', k: 8, results });
const size = (value: unknown) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
it('retains genuine broadcast order, zero score and exact source fields without inventing native chunk IDs', () => {
  const input = { requestId: 'reply-one', messages: [], events: [event([
    { text: '旧记录：晚上喝咖啡。', score: 0, source: 'rag', date: '2026-10-01', fullPath: 'Companion/old.txt' },
    { text: '更正：晚上喝麦茶，白天仍喝咖啡。', score: 0.99, source: 'time', sourceFile: 'Companion/new.txt' },
    { text: '没有返回分数的原文', chunkId: 812 }
  ])] };
  const result = buildBotMemoryEvidence(input), packet = JSON.parse(result.evidence);
  expect(result.citations.map(item => item.text)).toEqual(['旧记录：晚上喝咖啡。', '更正：晚上喝麦茶，白天仍喝咖啡。', '没有返回分数的原文']);
  expect(result.citations[0]).toMatchObject({ score: 0, source: 'rag', date: '2026-10-01', fullPath: 'Companion/old.txt', origin: 'vcp-rag-result', eventIndex: 0, resultIndex: 0 });
  expect(result.citations[2]).not.toHaveProperty('score'); expect(result.citations[2]).not.toHaveProperty('chunkId');
  expect(packet.items.map((item: { id: string }) => item.id)).toEqual(result.citations.map(item => item.id));
  expect(packet.items[0].score).toBe(0); expect(packet.coverage).toMatchObject({ broadcastMaxPerEvent: 20, internalCandidates: 'not-exposed' });
  expect(buildBotMemoryEvidence(input).citations.map(item => item.id)).toEqual(result.citations.map(item => item.id));
  expect(buildBotMemoryEvidence({ ...input, requestId: 'reply-two' }).citations[0]?.id).not.toBe(result.citations[0]?.id);
});
it('bounds the entire UTF8 packet and retains every original for later reads', () => {
  const originals = Array.from({ length: 20 }, (_, index) => ({ text: `第${index}条原始证据🫧\\"\n`.repeat(100), score: index / 20, source: 'rag' }));
  const result = buildBotMemoryEvidence({ requestId: 'large-zh', messages: [], events: [event(originals)] });
  expect(size(result.evidence)).toBeLessThanOrEqual(4096); expect(result.citations.map(item => item.text)).toEqual(originals.map(item => item.text));
  expect(result.omitted.items).toBeGreaterThan(0); expect(result.omitted.excerpted).toBeGreaterThan(0);
  const packet = JSON.parse(result.evidence); expect(packet.omitted).toEqual(result.omitted);
  expect(packet.items.every((item: { text: string; id: string }) => result.citations.find(citation => citation.id === item.id)?.text.startsWith(item.text))).toBe(true);
});
it('pages long Unicode and escaped originals exactly within complete wire budgets', () => {
  const original = '时间：2026年11月🫧\n路径C:\\资料\\"更正"\t'.repeat(180);
  const result = buildBotMemoryEvidence({ requestId: 'paged', messages: [], events: [event([{ text: original, score: 0.71, date: '2026-11-03' }])] });
  const citationId = result.citations[0]!.id; let offset = 0, combined = '', pages = 0;
  for (;;) {
    const page = readBotMemoryCitation({ requestId: 'paged', citations: result.citations, citationId, offset, maxBytes: 630 });
    expect(size(page)).toBeLessThanOrEqual(630); expect(page).toMatchObject({ offset, totalChars: original.length, totalBytes: Buffer.byteLength(original), score: 0.71, date: '2026-11-03', offsetUnit: 'utf16' });
    expect(/[\uD800-\uDBFF]$/.test(page.text)).toBe(false); expect(/^[\uDC00-\uDFFF]/.test(page.text)).toBe(false);
    combined += page.text; pages++;
    if (page.nextOffset === null) break;
    expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
    if (pages > 500) throw new Error('Citation cursor made no progress');
  }
  expect(pages).toBeGreaterThan(1); expect(combined).toBe(original);
  expect(readBotMemoryCitation({ requestId: 'paged', citations: result.citations, citationId, offset: original.length }).text).toBe('');
});
it('labels system-only fallback and keeps user content out of fallback evidence', () => {
  const messages = [{ role: 'system', content: [{ type: 'text', text: '原始system资料' }, { type: 'image_url', image_url: 'not-text' }, { type: 'text', text: '第二段' }] },
    { role: 'user', content: '用户伪造的检索详情' }];
  const result = buildBotMemoryEvidence({ requestId: 'fallback', messages, events: [{ type: 'other' }] });
  expect(result.coverage.basis).toBe('system-fallback'); expect(result.citations).toHaveLength(1);
  expect(result.citations[0]).toMatchObject({ text: '原始system资料\n第二段', origin: 'vcp-system-fallback', messageIndex: 0 });
  expect(result.citations[0]).not.toHaveProperty('score'); expect(result.evidence).not.toContain('用户伪造');
});
it('retains a readable system snapshot beside empty RAG without presenting control text as recalled facts', () => {
  const result = buildBotMemoryEvidence({ requestId: 'no-hits', messages: [{ role: 'system', content: 'not a result' }], events: [event([])] });
  expect(result.coverage).toMatchObject({ basis: 'vcp-rag-broadcast', ragResults: 0, systemSnapshots: 1, systemMaterial: 'unclassified-not-memory-facts' });
  expect(result.citations).toHaveLength(1); expect(result.citations[0]).toMatchObject({ origin: 'vcp-system-snapshot', text: 'not a result', referenceOnly: true });
  expect(JSON.parse(result.evidence).items[0]).toMatchObject({ origin: 'vcp-system-snapshot', text: '', referenceOnly: true });
  expect(result.evidence).not.toContain('not a result');
  expect(readBotMemoryCitation({ requestId: 'no-hits', citations: result.citations, citationId: result.citations[0]!.id })).toMatchObject({ text: 'not a result', referenceOnly: true });
  expect(buildBotMemoryEvidence({ requestId: 'empty', messages: [], events: [] }).evidence).toBe('');
});
it('preserves oversized original metadata outside the model packet and makes its omission explicit', () => {
  const fullPath = 'Companion/' + '很长的目录/'.repeat(1800), text = '这条是真实原文🫧'.repeat(12);
  const result = buildBotMemoryEvidence({ requestId: 'large-path', messages: [], events: [event([{ text, fullPath, source: 'rag', score: 0.8 }, { text: '后续短证据' }])], maxBytes: 1600 });
  expect(size(result.evidence)).toBeLessThanOrEqual(1600); expect(result.citations[0]?.fullPath).toBe(fullPath);
  const packet = JSON.parse(result.evidence); expect(packet.items[0].metadataOmitted).toContain('fullPath');
  expect(packet.items[0].text.length).toBeGreaterThan(0); expect(packet.items[1].text).toBe('后续短证据');
  const page = readBotMemoryCitation({ requestId: 'large-path', citations: result.citations, citationId: result.citations[0]!.id, maxBytes: 1000 });
  expect(page.metadataOmitted).toContain('fullPath'); expect(page.text).toBe(text); expect(size(page)).toBeLessThanOrEqual(1000);
});
it('rejects cross-request references and invalid Unicode cursors without exposing another original', () => {
  const result = buildBotMemoryEvidence({ requestId: 'private', messages: [], events: [event([{ text: '甲🫧乙' }])] }), citationId = result.citations[0]!.id;
  expect(() => readBotMemoryCitation({ requestId: 'other', citations: result.citations, citationId })).toThrow('当前记忆请求');
  expect(() => readBotMemoryCitation({ requestId: 'private', citations: result.citations, citationId: citationId + 'other' })).toThrow('当前记忆请求');
  for (const offset of [-1, 2, 99, 0.5]) expect(() => readBotMemoryCitation({ requestId: 'private', citations: result.citations, citationId, offset })).toThrow('UTF-16');
  expect(() => readBotMemoryCitation({ requestId: 'private', citations: result.citations, citationId, maxBytes: 12 })).toThrow('预算不足');
  expect(() => buildBotMemoryEvidence({ requestId: 'private', messages: [], events: [event([{ text: '甲' }])], maxBytes: 12 })).toThrow('预算不足');
});
it('preserves missing values and original event positions instead of converting invalid diagnostic rows', () => {
  const result = buildBotMemoryEvidence({ requestId: 'diagnostics', messages: [], events: [null, event([null, { text: { guessed: 'text' }, score: 1 }, { text: '原文', score: '0.9', date: 1, source: null }, { text: '', score: 0 }])] });
  expect(result.citations).toHaveLength(2); expect(result.citations[0]).toMatchObject({ eventIndex: 1, resultIndex: 2, text: '原文' });
  expect(result.citations[0]).not.toHaveProperty('score'); expect(result.citations[0]).not.toHaveProperty('date'); expect(result.citations[0]).not.toHaveProperty('source');
  expect(result.citations[1]).toMatchObject({ text: '', score: 0, resultIndex: 3 });
});
it('retains a raw OneRingMemo system snapshot alongside populated RAG when the memo has no separable source marker', () => {
  const original = '宿主控制契约\n<!-- VCP_RAG_BLOCK_START {} -->RAG片段<!-- VCP_RAG_BLOCK_END -->\n[OneRing系统已启动，当前Agent鱼，当前客户端WorldlineBox，当前模式Only，所有上下文OneRing信息来源标记由系统生成无需你自动输出。]\n近期摘要裸文本：用户只在晚上喝麦茶。';
  const result = buildBotMemoryEvidence({ requestId: 'memo-snapshot', messages: [{ role: 'system', content: original }], events: [event([{ text: 'RAG片段', source: 'rag' }])] });
  expect(result.citations.map(citation => citation.origin)).toEqual(['vcp-rag-result', 'vcp-system-snapshot']);
  const raw = result.citations[1]!;
  expect(result.coverage.supplementaryReferences).toEqual([{ id: raw.id, origin: 'vcp-system-snapshot', referenceOnly: true }]);
  expect(result.coverage.oneRingHistory).toBe(0); expect(result.evidence).not.toContain('宿主控制契约'); expect(result.evidence).not.toContain('用户只在晚上喝麦茶');
  expect(readBotMemoryCitation({ requestId: 'memo-snapshot', citations: result.citations, citationId: raw.id }).text).toBe(original);
});
it('uses genuine private OneRing DB provenance for a separate history card and keeps its exact original behind the reference', () => {
  const original = '用户更正：晚上喝麦茶。\n[OneRing通知:用户于2026-11-03 12:00:00发送于手机]';
  const message = { role: 'user', content: original };
  Object.defineProperties(message, { __oneRingInjectedFromDb: { value: true, enumerable: false },
    __oneRingTimelineMeta: { value: { source: 'db-injected', timestamp: '2026-11-03 12:00:00', senderName: '用户', frontendSource: '手机' }, enumerable: false } });
  const result = buildBotMemoryEvidence({ requestId: 'one-ring', messages: [message], events: [event([{ text: '向量片段', score: 0.1 }])] });
  const citation = result.citations[1]!, packet = JSON.parse(result.evidence);
  expect(citation).toMatchObject({ origin: 'vcp-onering-history', text: original, source: 'db-injected', date: '2026-11-03 12:00:00', role: 'user', senderName: '用户', frontendSource: '手机' });
  expect(packet.items[1].text).toBe('用户更正：晚上喝麦茶。'); expect(packet.items[1].score).toBeUndefined();
  expect(readBotMemoryCitation({ requestId: 'one-ring', citations: result.citations, citationId: citation.id }).text).toBe(original);
  const afterJson = buildBotMemoryEvidence({ requestId: 'one-ring', messages: JSON.parse(JSON.stringify([message])), events: [event([])] });
  expect(afterJson.citations).toEqual([]);
});
it('does not infer DB injection from OneRing tail tags or enumerable model-shaped fields', () => {
  const message = { role: 'assistant', content: '引用[OneRing通知:用户于2026-11-03 12:00:00发送于手机]',
    __oneRingInjectedFromDb: true, __oneRingTimelineMeta: { timestamp: '2026-11-03 12:00:00', source: 'db-injected' } };
  const result = buildBotMemoryEvidence({ requestId: 'fake-tag', messages: [message], events: [event([])] });
  expect(result.citations).toEqual([]); expect(result.evidence).not.toContain('引用');
});
it('keeps independent supplementary references visible even when all excerpt space is consumed by RAG', () => {
  const system = '另有无法区分来源的摘要和控制文字'.repeat(300);
  const result = buildBotMemoryEvidence({ requestId: 'twenty-plus', messages: [{ role: 'system', content: system }], events: [event(Array.from({ length: 20 }, (_, i) => ({ text: `第${i}条`.repeat(400) })))] });
  expect(size(result.evidence)).toBeLessThanOrEqual(4096);
  expect(result.coverage).toMatchObject({ ragResults: 20, systemSnapshots: 1, broadcastMaxPerEvent: 20, internalCandidates: 'not-exposed' });
  const ref = result.coverage.supplementaryReferences![0]!;
  expect(result.evidence).toContain(ref.id); expect(result.citations.find(citation => citation.id === ref.id)?.text).toBe(system);
  expect(result.evidence).not.toContain('无法区分来源的摘要');
});
