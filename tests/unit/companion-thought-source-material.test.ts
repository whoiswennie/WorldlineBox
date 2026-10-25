import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { buildCompanionThoughtPrompt } from '../../src/main/companions/thought-source-material';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionStorageCommandSchema, companionTaskCheckpointSchema } from '../../src/shared/companion-storage';
import { dshTaskInputSchema } from '../../src/shared/dsh-tasks';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = { companionId: 'alice', conversationId: 'room' };
const source = (index: number, content = '作者的说法仍需核对。'): CompanionMessage => ({ id: `message_${index}`, conversationId: 'room',
  sequence: index, authorId: 'bob', kind: 'text', content, createdAt: new Date(Date.UTC(2026, 9, 25, 0, 0, index)).toISOString(), status: 'sent', attachments: [] });

it('delivers bounded real source excerpts with exact checksums, omissions and an unchanged maximum-size question', async () => {
  const messages = Array.from({ length: 105 }, (_, index) => source(index + 1, ('原话😀\n\u0000"' + index).repeat(2000)));
  const readset = captureCompanionExecutionReadset(scope, { sources: messages.map(message => ({ id: message.id, conversationId: message.conversationId, checksum: hash(message.content) })) });
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type !== 'memory.sources.filter') throw new Error('Unexpected read');
    expect(command.companionId).toBe(scope.companionId);
    expect(command.conversationId).toBe(scope.conversationId);
    expect(command.ids.length).toBeLessThanOrEqual(100);
    return { ok: true, memorySources: messages.filter(message => command.ids.includes(message.id)) };
  });
  const question = '请独立核实当前作者的说法。'.padEnd(16000, '问');
  const prompt = await buildCompanionThoughtPrompt({ prompt: question, executionReadset: readset }, { request });
  const packet = JSON.parse(prompt).hostSourceMaterial;
  expect(JSON.parse(prompt).question).toBe(question);
  expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(65536);
  expect(packet).toMatchObject({ totalSources: 105, candidateSources: 100, omittedCandidates: 5, memoryBodiesIncluded: false });
  expect(Buffer.byteLength(JSON.stringify(packet), 'utf8')).toBeLessThanOrEqual(24000);
  expect(packet.directory[0].id).toBe('message_105');
  expect(packet.directoryOmitted + packet.directory.length).toBe(105);
  expect(packet.bodiesOmitted + packet.materials.length).toBe(105);
  for (const material of packet.materials) {
    const original = messages.find(message => message.id === material.id)!;
    expect(material).toMatchObject({ conversationId: original.conversationId, checksum: hash(original.content), textChecksum: hash(material.text),
      start: 0, end: material.text.length, originalChars: original.content.length, truncated: true });
    expect(material.text).toBe(original.content.slice(0, material.end));
    expect(packet.directory.some((entry: { id: string }) => entry.id === material.id)).toBe(true);
  }
  expect(dshTaskInputSchema.safeParse({ prompt }).success).toBe(true);
  expect(companionTaskCheckpointSchema.safeParse({ prompt, executionReadset: readset, supplements: [], waitForActionIds: [] }).success).toBe(true);
  expect(companionStorageCommandSchema.safeParse({ type: 'activity.thought.create', taskId: 'task', leaseToken: 'lease', expectedStep: 0,
    effectId: 'effect', observationFingerprint: '[]', executionReadset: readset, prompt, title: '核实' }).success).toBe(true);
  expect(await buildCompanionThoughtPrompt({ prompt: question, executionReadset: readset }, { request })).toBe(prompt);
});

it('rejects foreign rows, changed bytes and withdrawal during material construction instead of refreshing the captured proof', async () => {
  const message = source(1), readset = captureCompanionExecutionReadset(scope, { sources: [{ id: message.id, conversationId: message.conversationId, checksum: hash(message.content) }] });
  for (const mode of ['foreign', 'changed', 'withdrawn'] as const) {
    let calls = 0;
    const request = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true, memorySources: mode === 'foreign'
      ? [message, { ...message, id: 'not_in_host_readset' }]
      : mode === 'changed' ? [{ ...message, content: '新版本不能替换旧证明' }] : ++calls === 1 ? [message] : [] }));
    await expect(buildCompanionThoughtPrompt({ prompt: '核实', executionReadset: readset }, { request })).rejects.toThrow(/来源|资料/);
  }
});
