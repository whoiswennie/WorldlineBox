import BetterSqlite3 from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CompanionDshMailboxStore } from '../../src/companions/dsh-mailbox-store';
import type { CompanionConnection } from '../../src/companions/store';
import { companionDshInboxContext, controlCompanionDsh, CompanionDshWakeHub } from '../../src/main/companions/background-dsh';
import { ensureCompanionLoopContinuity } from '../../src/main/companions/loop-continuity';
import { companionDshControlSchema } from '../../src/shared/companion-dsh-background';
import type { CompanionAction } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
function fixture() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.exec('CREATE TABLE actions(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  const mailbox = new CompanionDshMailboxStore(db), hub = new CompanionDshWakeHub();
  const actions: CompanionAction[] = ['one', 'two'].map((id, index) => ({ id, companionId: 'same-role', conversationId: index ? 'other-room' : 'room',
    parentMessageId: index ? 'other-message' : 'bubble', title: id, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  for (const action of actions) db.prepare('INSERT INTO actions VALUES(?,?)').run(action.id, JSON.stringify(action));
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'action.get'
    ? { ok: true, action: actions.find(action => action.id === command.id) } : mailbox.execute(command)!;
  const checkpoint: CompanionLoopCheckpoint = { companionId: 'same-role', conversationId: 'room', messageId: 'bubble', sourceMessageId: 'user-message', status: 'running', turns: [], supplements: [] };
  const send = vi.fn(async () => undefined), cancel = vi.fn(async () => undefined), signal = new AbortController();
  const options = { request, hub, valid: async () => true, send, cancel };
  const control = (value: object, onWait?: (wake?: () => void) => void) => controlCompanionDsh({ checkpoint,
    operation: companionDshControlSchema.parse(value), effectId: 'exact-call', signal: signal.signal, onWait }, options);
  const append = (key: string, text: string, id = 'one') => request({ type: 'action.mail.append', mail: {
    actionId: id, direction: 'to_parent', kind: 'checkpoint', deduplicationKey: key, text } });
  return { db, mailbox, hub, actions, checkpoint, send, signal, control, append, request };
}

it('wakes the waiting main brain on user guidance without broadcasting it to a child or stopping background execution', async () => {
  const f = fixture(); let wake: (() => void) | undefined;
  try {
    const waiting = f.control({ operation: 'wait', actionIds: ['one'] }, value => { wake = value; });
    await vi.waitFor(() => expect(wake).toBeTypeOf('function'));
    f.checkpoint.supplements.push({ id: 'new-user', content: 'PRIVATE_USER_CHAT_NOT_CHILD_INPUT' }); wake!();
    expect(await waiting).toMatchObject({ wakeReason: 'user_input', interruptedByInput: true, tasks: [{ actionId: 'one', status: 'running' }] });
    expect(f.send).not.toHaveBeenCalled();
    const sent = await f.control({ operation: 'send', actionId: 'one', message: '主脑重新组织的任务更正' });
    expect(sent).toMatchObject({ accepted: true }); expect(f.send).toHaveBeenCalledWith(f.actions[0], '主脑重新组织的任务更正', 'steer', expect.any(String));
    const stored = await f.control({ operation: 'status', actionIds: ['one'] });
    expect(JSON.stringify(stored)).not.toContain('PRIVATE_USER_CHAT');
    expect(stored).toMatchObject({ messages: [{ direction: 'to_child', kind: 'instruction', text: '主脑重新组织的任务更正' }] });
  } finally { f.db.close(); }
});

it('delivers a child checkpoint once per durable cursor and isolates two loops of the same role', async () => {
  const f = fixture(); let ready = false;
  try {
    const waiting = f.control({ operation: 'wait', actionIds: ['one'] }, wake => { if (wake) ready = true; });
    await vi.waitFor(() => expect(ready).toBe(true));
    await f.append('report-elsewhere', '另一个任务的私有进度', 'two'); f.hub.notify('two');
    let returned = false; void waiting.then(() => { returned = true; }); await new Promise(resolve => setImmediate(resolve)); expect(returned).toBe(false);
    await f.append('checkpoint', '页面原型已完成，请决定配色'); await f.append('checkpoint', '页面原型已完成，请决定配色'); f.hub.notify('one');
    const result = await waiting; expect(result).toMatchObject({ wakeReason: 'child_event', messages: [{ text: '页面原型已完成，请决定配色' }] });
    expect(JSON.stringify(result)).not.toContain('另一个任务');
    const next = await f.control({ operation: 'status', actionIds: ['one'], after: 'nextAfter' in result ? result.nextAfter : 0 });
    expect(next).toMatchObject({ messages: [] });
    await expect(f.control({ operation: 'status', actionIds: ['two'] })).rejects.toThrow(/本次主脑/);
    await expect(f.append('checkpoint', '不允许替换旧消息')).rejects.toThrow(/不能替换/);
    f.db.prepare('DELETE FROM actions WHERE id=?').run('one');
    expect(f.db.prepare('SELECT count(*) AS total FROM companion_dsh_mailbox WHERE action_id=?').get('one')).toEqual({ total: 0 });
  } finally { f.db.close(); }
});

it('checks durable reports after subscribing so settlement between snapshot and wait is not lost', async () => {
  const f = fixture();
  try {
    const original = f.request; let reads = 0;
    const result = await controlCompanionDsh({ checkpoint: f.checkpoint, operation: companionDshControlSchema.parse({ operation: 'wait', actionIds: ['one'] }),
      effectId: 'wait-race', signal: f.signal.signal }, { hub: f.hub, valid: async () => true, send: f.send, cancel: async () => undefined,
      request: async command => {
        const response = await original(command);
        if (command.type === 'action.mail.read' && ++reads === 1) await f.append('race', '恰在进入等待时完成');
        return response;
      } });
    expect(result).toMatchObject({ wakeReason: 'child_event', messages: [{ text: '恰在进入等待时完成' }] });
  } finally { f.db.close(); }
});

it('does not spin on an already observed completed child while another child is still running', async () => {
  const f = fixture(); let wake: (() => void) | undefined;
  try {
    Object.assign(f.actions[1]!, { conversationId: 'room', parentMessageId: 'bubble', status: 'succeeded' });
    f.db.prepare('UPDATE actions SET data=? WHERE id=?').run(JSON.stringify(f.actions[1]), 'two');
    f.checkpoint.turns.push({ text: '', rawText: '', calls: [{ id: 'prior', name: 'dsh', arguments: '{"operation":"status","actionIds":["one","two"]}' }],
      results: [{ callId: 'prior', content: JSON.stringify({ ok: true, tasks: [{ id: 'two', status: 'succeeded', recordId: null }] }) }] });
    const waiting = f.control({ operation: 'wait', actionIds: ['one', 'two'] }, value => { wake = value; });
    await vi.waitFor(() => expect(wake).toBeTypeOf('function'));
    f.checkpoint.supplements.push({ id: 'new', content: '继续处理另一项' }); wake!();
    expect(await waiting).toMatchObject({ wakeReason: 'user_input' });
  } finally { f.db.close(); }
});

it('pages many small reports and large checkpoints without losing or splitting a message', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 55; index++) await f.append('small-' + index, '阶段' + index);
    let page = (await f.request({ type: 'action.mail.read', companionId: 'same-role', conversationId: 'room', parentMessageId: 'bubble', actionIds: ['one'] })).dshMailbox!;
    expect(page.items).toHaveLength(50); expect(page.hasMore).toBe(true);
    page = (await f.request({ type: 'action.mail.read', companionId: 'same-role', conversationId: 'room', parentMessageId: 'bubble', actionIds: ['one'], after: page.nextAfter })).dshMailbox!;
    expect(page.items).toHaveLength(5); expect(page.hasMore).toBe(false);
    const after = page.nextAfter;
    await f.append('large-1', '完整检查点甲'.repeat(1800)); await f.append('large-2', '完整检查点乙'.repeat(1800));
    const first = await f.control({ operation: 'status', actionIds: ['one'], after });
    expect(first).toMatchObject({ hasMore: true, messages: [{ text: '完整检查点甲'.repeat(1800) }] });
    const second = await f.control({ operation: 'status', actionIds: ['one'], after: 'nextAfter' in first ? first.nextAfter : 0 });
    expect(second).toMatchObject({ hasMore: false, messages: [{ text: '完整检查点乙'.repeat(1800) }] });
  } finally { f.db.close(); }
});

it('keeps live task handles, unanswered checkpoints and latest guidance outside a compressed step prefix', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 45; index++) f.checkpoint.turns.push({ text: '', rawText: '', calls: [{ id: 'read-' + index, name: 'dsh',
      arguments: '{"operation":"status","actionIds":["one"]}' }], results: [{ callId: 'read-' + index, content: '{"ok":true,"tasks":[]}' }] });
    await f.append('unanswered', '原型已完成，请决定配色。');
    const inbox = await companionDshInboxContext(f.checkpoint, f.actions.filter(action => action.id === 'one'), f.request, async () => true);
    const context = { system: '当前角色', user: JSON.stringify({ taskRequest: '制作网页', executionLedger: [{ actionId: 'one', status: 'running' }],
      backgroundInbox: inbox, latestGuidance: '改用蓝色，不要新增后台任务。' }) };
    const compacted = await ensureCompanionLoopContinuity({ checkpoint: f.checkpoint, turns: f.checkpoint.turns, context,
      config: { apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fixture' }, save: async () => undefined,
      summarize: async () => ({ summary: '原型制作中，已有后台任务，等待决定。', stage: '等待' }) });
    expect(compacted.turns.length).toBeLessThan(45); expect(f.checkpoint.turns).toHaveLength(45);
    expect(JSON.parse(compacted.context.user)).toMatchObject({ executionLedger: [{ actionId: 'one', status: 'running' }],
      backgroundInbox: [{ actionId: 'one', messages: [{ text: '原型已完成，请决定配色。' }] }], latestGuidance: '改用蓝色，不要新增后台任务。' });
    const sequence = inbox[0]!.messages[0]!.sequence;
    f.checkpoint.turns.push({ text: '', rawText: '', calls: [{ id: 'ack', name: 'dsh', arguments: JSON.stringify({ operation: 'status', actionIds: ['one'], after: sequence }) }],
      results: [{ callId: 'ack', content: '{"ok":true,"messages":[]}' }] });
    expect(await companionDshInboxContext(f.checkpoint, [f.actions[0]!], f.request, async () => true)).toEqual([]);
  } finally { f.db.close(); }
});
