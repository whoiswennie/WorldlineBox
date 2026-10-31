import path from 'node:path';
import { stat, utimes, writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionArtifact } from '../../src/shared/companion-artifact';
import { companionAgentJournal, type CompanionAgentJournal } from '../../src/main/companions/agent-journal';
import { companionTaskInvocation, runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import { companionMemoryRegisteredPath } from '../../src/main/companions/memory-library';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';

const config = { apiFormat: 'openai_chat' as const, model: 'host-gate-contract', baseUrl: 'https://unused.invalid/v1', apiKey: 'synthetic-only' };
const shape = z.object({ answer: z.string() });
const response = (content: string, calls?: unknown[]) => new Response(JSON.stringify({ choices: [{ message: { content, ...(calls ? { tool_calls: calls } : {}) } }] }));
const tool = [{ id: 'actual_tool', type: 'function', function: { name: 'world', arguments: '{"action":"query","category":"contacts"}' } }];

async function fixture() {
  const f = managedMemoryFiles(), source = f.source('当前来源允许完成这个独立测试任务。'), note = f.record('具有正式文件凭证的稳定事实。', [source.id]);
  await f.publish();
  const registry = await f.artifacts('alice'), artifact = (await registry.findByPath(companionMemoryRegisteredPath(note)))!;
  const read = () => registry.read({ artifactId: artifact.artifactId, consumer: 'episode_recall' });
  const base = companionAgentJournal(f.request);
  const journal: CompanionAgentJournal = {
    load: async (...args) => { await read(); return base.load(...args); },
    valid: async run => { await read(); return base.valid(run); },
    save: async run => { await read(); await base.save(run); },
  };
  const state = f.store.request({ type: 'state' }).state!;
  const conversation = state.conversations.find(room => room.id === f.scope.conversationId)!;
  const companion = state.companions.find(owner => owner.id === 'alice')!;
  const invocation = companionTaskInvocation({ companion, conversationId: conversation.id, id: 'actual_host_gate', kind: 'peer', goal: source.content,
    createdAt: source.createdAt, source, messageIds: [source.id] });
  const input = { context: { system: '按领域契约完成实际测试任务。', user: JSON.stringify({ purpose: 'world_social' }) },
    frame: { companion, conversation, messages: [source], sourceMessage: source, memories: [], invocation }, journal,
    responseSchema: shape, validateOutput: (value: unknown) => shape.parse(value), observeReadset: async () => { await read(); } };
  const rewrite = (change: (record: CompanionArtifact) => CompanionArtifact) => {
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    try {
      const found = db.prepare('SELECT metadata FROM companion_artifacts WHERE owner_id=? AND artifact_id=?').get('alice', artifact.artifactId) as { metadata: string };
      db.prepare('UPDATE companion_artifacts SET metadata=? WHERE owner_id=? AND artifact_id=?').run(JSON.stringify(change(JSON.parse(found.metadata))), 'alice', artifact.artifactId);
    } finally { db.close(); }
  };
  f.commands.length = 0;
  return { f, note, read, input, journal, rewrite, metadataReads: () => f.commands.filter(command => command.type === 'cognition.registry.read').length };
}

it('shares real SQL/file admissions across preparation and journal callbacks, with fresh fences before HTTP and effects', async () => {
  const h = await fixture();
  try {
    const effect = vi.fn(async () => { expect(h.metadataReads()).toBe(6); await h.read(); return { ok: true, result: 'Actual native result' }; });
    const fetchFn = vi.fn<typeof fetch>(async (): Promise<Response> => {
      // Each finite gate has one initial read and two fresh final metadata/ref
      // snapshots. Repeated callbacks do not create independent final fences.
      expect(h.metadataReads()).toBe(fetchFn.mock.calls.length === 1 ? 3 : 12);
      return fetchFn.mock.calls.length === 1 ? response('', tool) : response('{"answer":"done"}');
    });
    const value = await runCompanionStructuredAgent({ ...h.input, capabilities: {
      tools: [{ name: 'world', description: 'Current contacts', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['query'] }, category: { type: 'string', enum: ['contacts'] } }, required: ['action', 'category'] } }], execute: effect,
    } }, config, undefined, { fetchFn });
    expect(value).toEqual({ answer: 'done' }); expect(effect).toHaveBeenCalledTimes(1); expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(h.metadataReads()).toBe(15);
    const before = h.metadataReads(); await h.read(); expect(h.metadataReads() - before).toBe(3); // No proof escapes the task gate.
  } finally { await h.f.close(); }
});

it('rejects an external SQLite permission change in the original lifecycle before actual HTTP', async () => {
  const h = await fixture();
  try {
    const fetchFn = vi.fn<typeof fetch>(async () => response('{"answer":"must not be sent"}'));
    await expect(runCompanionStructuredAgent(h.input, { ...config, providerLifecycle: { beforeDispatch: async () => {
      h.rewrite(record => ({ ...record, allowedConsumers: ['audit'] })); return async () => {};
    } } }, undefined, { fetchFn })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  } finally { await h.f.close(); }
});

it('reopens canonical bytes after HTTP, rejects same-size same-mtime edits, and dispatches no tool effect', async () => {
  const h = await fixture();
  try {
    const effect = vi.fn(async () => ({ ok: true })), file = h.f.noteFile(h.note), before = await stat(file);
    const fetchFn = vi.fn<typeof fetch>(async () => {
      await writeFile(file, h.note.content.replace('稳定', '篡改'), 'utf8'); await utimes(file, before.atime, before.mtime);
      return response('', tool);
    });
    await expect(runCompanionStructuredAgent({ ...h.input, capabilities: {
      tools: [{ name: 'world', description: 'Current contacts', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['query'] }, category: { type: 'string', enum: ['contacts'] } }, required: ['action', 'category'] } }], execute: effect,
    } }, config, undefined, { fetchFn })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(effect).not.toHaveBeenCalled();
  } finally { await h.f.close(); }
});

it('fences a real source/permission withdrawal after durable intent before effect dispatch', async () => {
  const h = await fixture();
  try {
    const effect = vi.fn(async () => ({ ok: true }));
    const journal: CompanionAgentJournal = { ...h.journal, save: async run => {
      await h.journal.save(run);
      if (run.effects.some(effect => effect.state === 'dispatched')) h.rewrite(record => ({ ...record, publicationState: 'revoked' }));
    } };
    await expect(runCompanionStructuredAgent({ ...h.input, journal, capabilities: {
      tools: [{ name: 'world', description: 'Current contacts', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['query'] }, category: { type: 'string', enum: ['contacts'] } }, required: ['action', 'category'] } }], execute: effect,
    } }, config, undefined, { fetchFn: async () => response('', tool) })).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
  } finally { await h.f.close(); }
});

it('drops a cancelled preparation frame without leaking a cached permission proof into a fresh gate', async () => {
  const h = await fixture(), controller = new AbortController();
  try {
    const fetchFn = vi.fn<typeof fetch>(async () => response('{"answer":"must not be sent"}'));
    await expect(runCompanionStructuredAgent(h.input, { ...config, providerLifecycle: { beforeDispatch: async () => {
      controller.abort(); return async () => {};
    } } }, controller.signal, { fetchFn })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    const before = h.metadataReads(); await withCompanionExecutionValidation(() => h.read()); expect(h.metadataReads() - before).toBe(3);
  } finally { await h.f.close(); }
});
