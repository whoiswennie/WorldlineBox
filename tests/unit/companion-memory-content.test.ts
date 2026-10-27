import { expect, it } from 'vitest';
import { companionHistoryView, companionNarrativeText } from '../../src/shared/companion-memory-content';
import { companionMemoryCandidateSchema } from '../../src/shared/companion-memory';

const content = '# 一起准备晚餐\n\n她选择了南瓜汤，约好下次一起做。';
const archive = '---\n' + JSON.stringify({ schema: 'worldlinebox.companion-memory-history-v1', id: 'note_123', bodyHash: 'a'.repeat(64), contentRevision: 2,
  memory: { id: 'note_123', scopeId: 'scope_internal', tags: ['晚餐'] }, dependencies: [] }, null, 2) + '\n---\n' + content;
it('projects an archive into prose, a natural title and revision without leaking its provenance into search', () => {
  expect(companionHistoryView(archive)).toEqual({ content, title: '一起准备晚餐', version: 2, tags: ['晚餐'] });
  expect(companionNarrativeText(archive)).toBe(content);
  expect(companionNarrativeText('<!-- WorldlineBoxMemory:' + 'b'.repeat(64) + ' -->\n' + content)).toBe(content);
});
it('rejects host metadata in candidate prose while preserving meaningful technical examples', () => {
  const candidate = { content: archive, tags: [], sourceMessageIds: ['source'], evidence: [{ sourceMessageId: 'source', quote: '原文' }] };
  expect(companionMemoryCandidateSchema.safeParse(candidate).success).toBe(false);
  const technical = '接口返回 {"id":"order_123"}；校验示例 SHA-256=' + 'a'.repeat(64);
  expect(companionNarrativeText(technical)).toBe(technical);
  expect(companionMemoryCandidateSchema.safeParse({ ...candidate, content: technical }).success).toBe(true);
});
