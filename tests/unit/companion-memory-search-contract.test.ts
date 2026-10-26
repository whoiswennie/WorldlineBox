import { expect, it } from 'vitest';
import { z } from 'zod';
import { companionMemoryToolArgumentsSchemas, COMPANION_MEMORY_SEARCH_CONTRACT } from '../../src/shared/companion-memory-tool';
import { COMPANION_MEMORY_CAPABILITY_TOOL, normalizeCompanionCapabilityCall } from '../../src/shared/companion-capability-tools';
import { companionRecallCapabilities } from '../../src/main/companions/structured-agent';
import { companionMemorySelection } from '../../src/main/companions/memory-selection';
import { companionMemorySelectionSchema } from '../../src/shared/companion-memory-selection';
import { companionsResponseSchema } from '../../src/shared/companions';

it('advertises the existing bounded metadata browse and optional query in both actual memory tool entrances', () => {
  const schema = z.toJSONSchema(companionMemoryToolArgumentsSchemas['memory.search'], { io: 'input' });
  expect(schema.required ?? []).not.toContain('query');
  expect(JSON.stringify(schema.properties)).toContain('省略或空字符串');
  expect(JSON.stringify(schema.properties)).toContain('memoryPage.nextCursor');
  expect(COMPANION_MEMORY_CAPABILITY_TOOL.description).toContain(COMPANION_MEMORY_SEARCH_CONTRACT);
  const tools = companionRecallCapabilities(async () => ({ ok: true }), { companionId: 'alice', conversationId: 'private-alice' }).tools;
  expect(tools.find(tool => tool.name === 'memory')?.description).toContain(COMPANION_MEMORY_SEARCH_CONTRACT);
});

it.each([undefined, ''])('normalizes query=%s to the real metadata browse without accepting a model-supplied owner', query => {
  const input = { action: 'search', tags: ['实际已知标签'], limit: 1, cursor: 2, ...(query === undefined ? {} : { query }) };
  const call = normalizeCompanionCapabilityCall({ id: 'actual_call', name: 'memory', arguments: JSON.stringify(input) });
  expect(call.name).toBe('memory.search');
  expect(JSON.parse(call.arguments)).toMatchObject({ query: '', tags: ['实际已知标签'], limit: 1, cursor: 2 });
  expect(() => normalizeCompanionCapabilityCall({ id: 'forged_owner', name: 'memory', arguments: JSON.stringify({ ...input, companionId: 'other' }) })).toThrow();
});

it('never claims a semantic candidate page exhausts the journal and never attests prior directory pages from the last cursor', () => {
  const scope = { companionId: 'alice', conversationId: 'private-alice', beforeSequence: 12 }, page = { items: [], hasMore: false };
  const ranked = companionMemorySelection({ ...scope, query: '一段相关经历', tags: ['已知'], limit: 2, cursor: 4 }, page);
  expect(ranked).toMatchObject({ kind: 'ranked_candidates', exhaustive: false, scope, paginationScope: 'same_ranked_candidates',
    filters: { tags: ['已知'] }, page: { cursor: 4, limit: 2, returned: 0, hasMore: false } });
  const directory = companionMemorySelection({ ...scope, tags: ['已知'], from: '2026-10-01', to: '2026-10-31', limit: 2, cursor: 4 }, page);
  expect(directory).toMatchObject({ kind: 'metadata_directory', scope, paginationScope: 'filtered_directory',
    directoryEndReached: true, priorPagesReadAttested: false, filters: { tags: ['已知'], from: '2026-10-01', to: '2026-10-31' }, page: { cursor: 4 } });
  expect(page).toEqual({ items: [], hasMore: false });
  expect(companionMemorySelectionSchema.safeParse({ ...ranked, exhaustive: true }).success).toBe(false);
  expect(companionsResponseSchema.safeParse({ ok: true, memorySelection: { ...directory, priorPagesReadAttested: true } }).success).toBe(false);
  expect(companionMemorySelectionSchema.safeParse({ ...directory, directoryEndReached: false }).success).toBe(false);
  expect(companionMemorySelectionSchema.safeParse({ ...directory, scope: { ...scope, world: '*' } }).success).toBe(false);
  expect(() => normalizeCompanionCapabilityCall({ id: 'forged_coverage', name: 'memory', arguments: JSON.stringify({ action: 'search', memorySelection: directory }) })).toThrow();
});
