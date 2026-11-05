import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotService } from '../../src/main/companion-bot/service';
import { BOT_PERSONA_TEMPLATE_LIMIT, botRequestSchema } from '../../src/shared/companion-bot';
import { DEFAULT_BOT_COMPANION_ID, builtinBotCompanion } from '../../src/shared/builtin-bot-companions';
import { builtinBotPersonaTemplates } from '../../src/shared/builtin-bot-personas';

let root: string, store: BotStore;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wlb-persona-templates-'));
  store = new BotStore(path.join(root, 'bot.sqlite'));
  store.createCompanion({ id: DEFAULT_BOT_COMPANION_ID, name: '大肥鱼', persona: builtinBotCompanion(DEFAULT_BOT_COMPANION_ID)!.persona });
  store.createCompanion({ id: 'custom', name: '自建伙伴', persona: '保留这份初始人格。' });
});
afterEach(() => {
  store.close();
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-persona-templates-')) throw Error('Invalid persona fixture cleanup');
  rmSync(root, { recursive: true, force: true });
});

it('lists bounded metadata and fetches the selected complete prompt without truncating documents', () => {
  const catalog = store.listPersonaTemplates(DEFAULT_BOT_COMPANION_ID);
  expect(catalog.activeId).toBe('default'); expect(catalog.items).toHaveLength(5);
  expect(catalog.items.map(item => item.id).sort()).toEqual(builtinBotPersonaTemplates(DEFAULT_BOT_COMPANION_ID).map(item => item.id).sort());
  expect(catalog.items.every(item => !('prompt' in item))).toBe(true);
  for (const builtin of builtinBotPersonaTemplates(DEFAULT_BOT_COMPANION_ID)) {
    expect(store.getPersonaTemplate(DEFAULT_BOT_COMPANION_ID, builtin.id)).toMatchObject({ name: builtin.name, prompt: builtin.prompt, builtin: true, modified: false });
  }
  expect(store.listPersonaTemplates('custom')).toMatchObject({ activeId: 'default', items: [{ id: 'default', builtin: false, isDefault: true }] });
});

it('preserves a legacy custom persona during migration, persisting its active selection across restart', () => {
  const filename = store.filename, exact = '  这是迁移前保存的个人人格。\n不要改写其字节。  ';
  store.close();
  const PersonaDatabase = Database as new (filename: string) => { prepare(sql: string): { run(...args: unknown[]): unknown }; exec(sql: string): void; close(): void };
  const legacy = new PersonaDatabase(filename);
  legacy.prepare('UPDATE bot_companions SET persona=? WHERE id=?').run(exact, DEFAULT_BOT_COMPANION_ID);
  legacy.exec('DROP TABLE bot_persona_settings; DROP TABLE bot_persona_templates; PRAGMA user_version=17'); legacy.close();
  store = new BotStore(filename);
  expect(store.getCompanion(DEFAULT_BOT_COMPANION_ID)).toMatchObject({ persona: exact, activePersonaId: 'custom-current' });
  expect(store.getPersonaTemplate(DEFAULT_BOT_COMPANION_ID, 'custom-current')).toMatchObject({ builtin: false, prompt: exact });
  expect(store.getPersonaTemplate(DEFAULT_BOT_COMPANION_ID, 'default').prompt).toBe(builtinBotCompanion(DEFAULT_BOT_COMPANION_ID)!.persona);
  store.close(); store = new BotStore(filename);
  expect(store.getCompanion(DEFAULT_BOT_COMPANION_ID)).toMatchObject({ persona: exact, activePersonaId: 'custom-current' });
});

it('atomically activates edits and renames stable templates while preserving prompts in other companions', () => {
  const exact = '  自定义人格\n完整保留空行和末尾空格。  ';
  const first = store.savePersonaTemplate(DEFAULT_BOT_COMPANION_ID, { name: '工作中的我', prompt: exact });
  expect(store.getCompanion(DEFAULT_BOT_COMPANION_ID)!.activePersonaId).toBe('default');
  store.activatePersonaTemplate(DEFAULT_BOT_COMPANION_ID, first.id);
  expect(store.getCompanion(DEFAULT_BOT_COMPANION_ID)).toMatchObject({ activePersonaId: first.id, persona: exact });
  const renamed = store.savePersonaTemplate(DEFAULT_BOT_COMPANION_ID, { id: first.id, name: '新的名称', prompt: '下一条消息使用的版本' });
  expect(renamed.id).toBe(first.id); expect(renamed.name).toBe('新的名称');
  expect(store.getCompanion(DEFAULT_BOT_COMPANION_ID)!.persona).toBe(renamed.prompt);
  store.updateCompanion(DEFAULT_BOT_COMPANION_ID, { name: '只修改昵称' });
  expect(store.getCompanion(DEFAULT_BOT_COMPANION_ID)).toMatchObject({ name: '只修改昵称', activePersonaId: first.id, persona: renamed.prompt });
  store.updateCompanion(DEFAULT_BOT_COMPANION_ID, { name: '兼容旧编辑器', persona: '旧接口的明确人格修改' });
  expect(store.getPersonaTemplate(DEFAULT_BOT_COMPANION_ID, first.id).prompt).toBe('旧接口的明确人格修改');
  expect(store.getCompanion('custom')!.persona).toBe('保留这份初始人格。');
  expect(() => store.getPersonaTemplate('custom', first.id)).toThrow('不存在');
});

it('restores original built-in names and prompts, revives deleted built-ins and retains custom templates', () => {
  const original = builtinBotPersonaTemplates(DEFAULT_BOT_COMPANION_ID)[1]!;
  store.savePersonaTemplate(DEFAULT_BOT_COMPANION_ID, { id: original.id, name: '已改的内置名称', prompt: '已改的内置内容', activate: true });
  expect(store.getPersonaTemplate(DEFAULT_BOT_COMPANION_ID, original.id).modified).toBe(true);
  expect(store.restorePersonaTemplates(DEFAULT_BOT_COMPANION_ID, original.id)).toMatchObject({ name: original.name, prompt: original.prompt, modified: false });
  store.deletePersonaTemplate(DEFAULT_BOT_COMPANION_ID, original.id);
  expect(store.listPersonaTemplates(DEFAULT_BOT_COMPANION_ID).items.some(item => item.id === original.id)).toBe(false);
  expect(store.getCompanion(DEFAULT_BOT_COMPANION_ID)!.activePersonaId).toBe('default');
  const custom = store.savePersonaTemplate(DEFAULT_BOT_COMPANION_ID, { name: '我的模板', prompt: '保留我的模板', activate: true });
  const filename = store.filename; store.close(); store = new BotStore(filename);
  expect(store.listPersonaTemplates(DEFAULT_BOT_COMPANION_ID).items.some(item => item.id === original.id)).toBe(false);
  store.restorePersonaTemplates(DEFAULT_BOT_COMPANION_ID);
  expect(store.listPersonaTemplates(DEFAULT_BOT_COMPANION_ID)).toMatchObject({ activeId: 'default' });
  expect(store.getPersonaTemplate(DEFAULT_BOT_COMPANION_ID, original.id).prompt).toBe(original.prompt);
  expect(store.getPersonaTemplate(DEFAULT_BOT_COMPANION_ID, custom.id).prompt).toBe('保留我的模板');
  expect(() => store.deletePersonaTemplate(DEFAULT_BOT_COMPANION_ID, 'default')).toThrow('默认人格不能删除');
  expect(() => store.restorePersonaTemplates(DEFAULT_BOT_COMPANION_ID, custom.id)).toThrow('只能恢复');
});

it('deletes the active custom template with a valid default fallback and enforces limits without partial writes', () => {
  const active = store.savePersonaTemplate('custom', { name: '暂用', prompt: '暂用人格', activate: true });
  store.deletePersonaTemplate('custom', active.id);
  expect(store.getCompanion('custom')).toMatchObject({ activePersonaId: 'default', persona: '保留这份初始人格。' });
  for (let i = 1; i < BOT_PERSONA_TEMPLATE_LIMIT; i++) store.savePersonaTemplate('custom', { name: `模板 ${i}`, prompt: `人格 ${i}` });
  expect(store.listPersonaTemplates('custom').items).toHaveLength(BOT_PERSONA_TEMPLATE_LIMIT);
  expect(() => store.savePersonaTemplate('custom', { name: '超额', prompt: '不得保存', activate: true })).toThrow('最多保存');
  expect(store.getCompanion('custom')!.activePersonaId).toBe('default');
  expect(() => store.savePersonaTemplate('custom', { id: 'default', name: 'n'.repeat(81), prompt: '不改' })).toThrow('模板名称');
  expect(() => store.savePersonaTemplate('custom', { id: 'default', name: '不改', prompt: 'p'.repeat(24001) })).toThrow('24000');
  expect(() => store.savePersonaTemplate('custom', { id: 'missing', name: '不改', prompt: '不改' })).toThrow('不存在');
  expect(store.getPersonaTemplate('custom', 'default').prompt).toBe('保留这份初始人格。');
});

it('reserves deleted built-in slots so restoring a full catalog never removes user templates', () => {
  const companionId = DEFAULT_BOT_COMPANION_ID, builtin = builtinBotPersonaTemplates(companionId)[1]!;
  store.deletePersonaTemplate(companionId, builtin.id);
  const customIds: string[] = [];
  for (let i = 5; i < BOT_PERSONA_TEMPLATE_LIMIT; i++) customIds.push(store.savePersonaTemplate(companionId, { name: `自建 ${i}`, prompt: `保留 ${i}` }).id);
  expect(store.listPersonaTemplates(companionId).items).toHaveLength(BOT_PERSONA_TEMPLATE_LIMIT - 1);
  expect(() => store.savePersonaTemplate(companionId, { name: '不能占内置恢复槽位', prompt: '不保存' })).toThrow('最多保存');
  store.restorePersonaTemplates(companionId);
  expect(store.listPersonaTemplates(companionId).items).toHaveLength(BOT_PERSONA_TEMPLATE_LIMIT);
  expect(store.listPersonaTemplates(companionId).items.filter(item => customIds.includes(item.id))).toHaveLength(customIds.length);
});

it('rolls back an active template edit if its companion prompt cannot commit', () => {
  const current = store.getPersonaTemplate('custom', 'default');
  store.taskTransaction(sql => sql.prepare("CREATE TRIGGER reject_persona_change BEFORE UPDATE OF persona ON bot_companions WHEN NEW.id='custom' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END").run());
  expect(() => store.savePersonaTemplate('custom', { id: 'default', name: '不能只提交名字', prompt: '不能只提交模板' })).toThrow('fixture write failure');
  expect(store.getPersonaTemplate('custom', 'default')).toEqual(current);
  expect(store.getCompanion('custom')).toMatchObject({ activePersonaId: 'default', persona: current.prompt });
});

it('exposes the persona protocol through BotService and a name-only update cannot overwrite an activation', async () => {
  const service = Object.create(BotService.prototype) as BotService;
  Object.assign(service, { store, starting: Promise.resolve(), closed: false, changed: vi.fn() });
  const saved = await service.handle({ type: 'companion.personas.save', companionId: 'custom', name: '执行模式', prompt: '已激活新的人格', activate: true });
  expect(saved.personas!.activeId).toBe(saved.persona!.id);
  await service.handle({ type: 'companion.update', companionId: 'custom', name: '新昵称' });
  expect(store.getCompanion('custom')!.persona).toBe('已激活新的人格');
  expect((await service.handle({ type: 'companion.personas.get', companionId: 'custom', id: saved.persona!.id })).persona!.prompt).toBe('已激活新的人格');
  await service.handle({ type: 'companion.personas.delete', companionId: 'custom', id: saved.persona!.id });
  expect((await service.handle({ type: 'companion.personas.list', companionId: 'custom' })).personas!.activeId).toBe('default');
  expect(botRequestSchema.safeParse({ type: 'companion.update', companionId: 'custom', name: '有效昵称' }).success).toBe(true);
  expect(botRequestSchema.safeParse({ type: 'companion.personas.save', companionId: 'custom', name: '有效模板', prompt: ' ' }).success).toBe(false);
});
