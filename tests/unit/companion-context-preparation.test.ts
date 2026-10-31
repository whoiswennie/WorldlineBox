import { expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import type { CompanionAction } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }));
const at = '2026-10-29T13:00:00.000Z', scope = { companionId: 'alice', conversationId: 'private_alice', beforeSequence: 99 };
function action(id: string, contentAvailable = true): CompanionAction { return { ...scope, id, title: contentAvailable ? '真实未完成任务' : '来源已变化的执行记录', status: 'running',
  sourceMessageId: 'source_' + id, contentAvailable, createdAt: at, updatedAt: at }; }
function host(call: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>) {
  return Object.assign(Object.create(CompanionService.prototype), { call }) as {
    ongoingGoals(input: typeof scope): Promise<Array<{ id: string; goal: string; status: string }>> };
}
it('requests only authoritative unfinished actions and never opens an unavailable checkpoint prompt', async () => {
  const call = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'actions') throw new Error('History must not be loaded just to enumerate unfinished goals.');
    if (command.type === 'actions.ongoing') return { ok: true, actions: [action('active'), action('withdrawn', false)] };
    if (command.type === 'checkpoint.get') {
      expect(command.id).toBe('active'); return { ok: true, checkpoint: { prompt: '真实正在进行的目标', waitForActionIds: [], supplements: [] } };
    }
    if (command.type === 'memory.sources.filter') return { ok: true, memorySources: ['active', 'withdrawn'].map(id => ({ id: 'source_' + id, conversationId: scope.conversationId,
      authorId: 'user', kind: 'text', status: 'sent', attachments: [], sequence: 1, content: '当时的委托', createdAt: at })) };
    return { ok: true };
  });
  const result = await host(call).ongoingGoals(scope);
  expect(result).toEqual([expect.objectContaining({ id: 'active', goal: '真实正在进行的目标', status: 'running' }),
    expect.objectContaining({ id: 'withdrawn', goal: '来源已变化的执行记录', status: 'running' })]);
  expect(call.mock.calls.filter(([command]) => command.type === 'checkpoint.get')).toHaveLength(1);
  expect(call.mock.calls.filter(([command]) => command.type === 'actions.ongoing')).toEqual([[{ type: 'actions.ongoing', companionId: 'alice', conversationId: 'private_alice' }]]);
});
it('loads independent active checkpoint prompts together while preserving returned task order', async () => {
  let release!: () => void, entered = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const call = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'actions.ongoing') return { ok: true, actions: [action('first'), action('second')] };
    if (command.type === 'checkpoint.get') { entered++; await gate; return { ok: true, checkpoint: { prompt: command.id, waitForActionIds: [], supplements: [] } }; }
    if (command.type === 'memory.sources.filter') return { ok: true, memorySources: ['first', 'second'].map(id => ({ id: 'source_' + id, conversationId: scope.conversationId,
      authorId: 'user', kind: 'text', status: 'sent', attachments: [], sequence: 1, content: '实际委托', createdAt: at })) };
    return { ok: true };
  });
  const pending = host(call).ongoingGoals(scope);
  try { await vi.waitFor(() => expect(entered).toBe(2), { timeout: 500, interval: 5 }); } finally { release(); }
  expect((await pending).map(task => task.goal)).toEqual(['first', 'second']);
}, 1500);

it('validates learning assets once for a repeated execution dependency within a preparation', async () => {
  const requireCurrentAssets = vi.fn(async () => undefined), verify = vi.fn(async () => true);
  const subject = Object.assign(Object.create(CompanionService.prototype), { requireCurrentAssets, executionEvidenceValidUncached: verify,
    sourceValidationRevision: 0 }) as { sourceValidationRevision: number; executionEvidenceValid(value: CompanionAction): Promise<boolean> };
  const dependency = action('shared_execution');
  await withCompanionExecutionValidation(async () => {
    expect(await subject.executionEvidenceValid(dependency)).toBe(true);
    expect(await subject.executionEvidenceValid(dependency)).toBe(true);
    expect(requireCurrentAssets).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledOnce();
    subject.sourceValidationRevision++;
    expect(await subject.executionEvidenceValid(dependency)).toBe(true);
    expect(requireCurrentAssets).toHaveBeenCalledTimes(2); expect(verify).toHaveBeenCalledTimes(2);
  });
  expect(await subject.executionEvidenceValid(dependency)).toBe(true);
  expect(requireCurrentAssets).toHaveBeenCalledTimes(3); expect(verify).toHaveBeenCalledTimes(3);
});
