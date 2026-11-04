import path from 'node:path';
import { expect, it, vi } from 'vitest';

const helperPath = '../../resources/dsh-bridge/workspace.js';
const { botProjectDirectory, prepareBotWorkspace, nameBotSession, attachBotWorkspace } = await import(helperPath);
const root = path.resolve('fixture-companion-root');
function fixture(name: string, legacy = false) {
  const cwd = path.join(root, name), input = { cwd, workspaceTitle: '大肥鱼', workspaceParent: { path: root, title: '大肥鱼' }, sessionTitle: name };
  const header = Object.freeze({ cwd: legacy ? cwd : root }); let effective = header.cwd;
  const directory = { get: () => effective, set: vi.fn(async (_agent: unknown, target: string) => { effective = target; }) };
  const agent = { session: { header, snapshotEvents: () => [] as Array<{ type: string }> }, ctx: { get: () => directory } };
  const record = { id: name, cwd, agent };
  const title = { get: vi.fn(() => undefined as unknown), rename: vi.fn() };
  const workspace = { title: '旧名称', setTitle: vi.fn(async (value: string) => { workspace.title = value; }), attachSession: vi.fn(async () => undefined) };
  const ctx = { get: () => title, sessions: { flush: vi.fn(async () => undefined) }, workspaceRegistry: { create: vi.fn(async () => workspace) } };
  return { input, record, ctx, workspace, directory, title, currentDirectory: () => effective };
}

it('groups distinct task Sessions under the companion project while retaining independent tool directories', async () => {
  const first = fixture('查询天气'), second = fixture('整理附件');
  for (const value of [first, second]) {
    expect(botProjectDirectory(value.input)).toBe(root);
    await prepareBotWorkspace(value.ctx, value.record, value.input);
    expect(value.title.rename).not.toHaveBeenCalled();
    await attachBotWorkspace(value.ctx, value.record, value.input);
    expect(value.currentDirectory()).toBe(value.input.cwd);
    expect(value.record.agent.session.header.cwd).toBe(root);
    expect(value.ctx.workspaceRegistry.create).toHaveBeenCalledWith(root, '大肥鱼');
    expect(value.workspace.attachSession).toHaveBeenCalledWith(value.record.id);
    expect(value.title.rename).toHaveBeenCalledWith(value.record.agent.session, value.input.sessionTitle);
  }
  expect(first.currentDirectory()).not.toBe(second.currentDirectory());
});

it('retains a restored working-directory transition and an explicit user Session title', async () => {
  const value = fixture('查询天气');
  await prepareBotWorkspace(value.ctx, value.record, value.input);
  nameBotSession(value.ctx, value.record, value.input);
  value.title.get.mockReturnValue({ source: { kind: 'user' }, title: '用户自定会话名' }); value.title.rename.mockClear();
  value.record.agent.session.snapshotEvents = () => [{ type: 'working-directory/change' }];
  await value.directory.set(value.record.agent, root); value.directory.set.mockClear();
  await prepareBotWorkspace(value.ctx, value.record, value.input);
  nameBotSession(value.ctx, value.record, value.input);
  expect(value.directory.set).not.toHaveBeenCalled();
  expect(value.title.rename).not.toHaveBeenCalled();
});

it('corrects legacy labels without rewriting immutable execution history or claiming a move', async () => {
  const value = fixture('原有任务', true);
  await prepareBotWorkspace(value.ctx, value.record, value.input);
  await attachBotWorkspace(value.ctx, value.record, value.input);
  expect(value.record.agent.session.header.cwd).toBe(value.input.cwd);
  expect(value.directory.set).not.toHaveBeenCalled();
  expect(value.ctx.workspaceRegistry.create).toHaveBeenCalledWith(value.input.cwd, '大肥鱼');
  expect(value.title.rename).toHaveBeenCalledWith(value.record.agent.session, '原有任务');
});

it('rejects unrelated project ownership and out-of-project task directories before registration', async () => {
  const value = fixture('查询天气');
  expect(() => botProjectDirectory({ ...value.input, cwd: path.resolve(root, '..', 'another-companion') })).toThrow('must contain');
  await expect(attachBotWorkspace(value.ctx, { ...value.record, agent: { ...value.record.agent, session: { header: { cwd: path.resolve('other-project') } } } }, value.input)).rejects.toThrow('ownership');
  expect(value.ctx.workspaceRegistry.create).not.toHaveBeenCalled();
});
