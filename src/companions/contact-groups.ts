import { randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionContactGroupStateSchema, initialCompanionContactGroups } from '../shared/companion-contact-groups';

/** Human contact-book organization; no changes to messages, membership or ACLs. */
export function companionContactGroups(db: CompanionConnection, input: CompanionStorageCommand): CompanionStorageResponse | undefined {
  if (!input.type.startsWith('contact.groups.')) return;
  const command = input as Extract<CompanionStorageCommand, { type: `contact.groups.${string}` }>;
  return db.transaction(() => {
    const saved = db.prepare("SELECT value FROM metadata WHERE key='contact-groups-v1'").get() as { value: string } | undefined;
    const state = saved ? companionContactGroupStateSchema.parse(JSON.parse(saved.value)) : initialCompanionContactGroups();
    if (command.type === 'contact.groups.read') return { ok: true, contactGroups: state };
    if (command.expectedRevision !== state.revision) throw new Error('分组已更新，请刷新后重试。');
    if (command.type === 'contact.groups.create') {
      if (state.groups.length >= 200) throw new Error('分组数量已达上限。');
      if (state.groups.some(group => group.kind === command.kind && group.name === command.name)) throw new Error('同类分组名称不能重复。');
      state.groups.push({ id: randomUUID(), kind: command.kind, name: command.name, system: false });
    } else {
      const group = state.groups.find(group => group.id === (command.type === 'contact.groups.assign' ? command.groupId : command.id));
      if (!group) throw new Error('分组不存在。');
      if (command.type === 'contact.groups.rename') {
        if (state.groups.some(item => item.id !== group.id && item.kind === group.kind && item.name === command.name)) throw new Error('同类分组名称不能重复。');
        group.name = command.name;
      } else if (command.type === 'contact.groups.remove') {
        if (group.system) throw new Error('默认分组需要保留，可以重命名。');
        state.groups = state.groups.filter(item => item.id !== group.id);
        for (const [item, target] of Object.entries(state.assignments)) if (target === group.id) delete state.assignments[item];
      } else {
        if (group.kind !== command.kind || new Set(command.itemIds).size !== command.itemIds.length) throw new Error('分组类型或成员列表无效。');
        for (const item of command.itemIds) {
          const valid = command.kind === 'contacts'
            ? db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(item)
            : db.prepare("SELECT 1 FROM conversations WHERE id=? AND kind='group' AND dissolved_at IS NULL AND NOT EXISTS(SELECT 1 FROM metadata WHERE key='world-room/'||conversations.id)").get(item);
          if (!valid) throw new Error('只能移动当前存在的伙伴或群聊。');
          state.assignments[item] = group.id;
        }
      }
    }
    state.revision++;
    db.prepare("INSERT INTO metadata(key,value) VALUES('contact-groups-v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(state));
    return { ok: true, contactGroups: state };
  }).immediate();
}
