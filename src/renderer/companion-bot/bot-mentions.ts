import type { BotCompanion } from '../../shared/companion-bot';

export interface BotMentionQuery { start: number; end: number; query: string }
export interface BotMentionOption { id: string; name: string; mention: string; companion?: BotCompanion }

/** Native textarea offsets are UTF-16 offsets; preserve all surrounding text. */
export function botMentionQuery(text: string, start: number, end = start): BotMentionQuery | undefined {
  if (!Number.isInteger(start) || start <= 0 || start > text.length || end !== start) return;
  const at = text.lastIndexOf('@', start - 1);
  if (at < 0 || start - at > 81 || /[A-Za-z0-9._%+-]/u.test(text[at - 1] ?? '')) return;
  const query = text.slice(at + 1, start);
  if (/[\s@]/u.test(query)) return;
  return { start: at, end: start, query };
}
export function botMentionOptions(members: readonly BotCompanion[], query: string, locale: 'zh-CN' | 'en'): BotMentionOption[] {
  const all = { id: '$all', name: locale === 'zh-CN' ? '所有人' : 'Everyone', mention: locale === 'zh-CN' ? '所有人' : 'all' };
  const key = query.normalize('NFKC').toLocaleLowerCase();
  const seen = new Set<string>(), entries: BotMentionOption[] = [all];
  for (const companion of members) {
    if (companion.id === 'user' || seen.has(companion.id)) continue;
    seen.add(companion.id); entries.push({ id: companion.id, name: companion.name, mention: companion.name, companion });
  }
  return entries.filter(entry => (entry.companion ? entry.name : `${entry.name} 所有人 all everyone`).normalize('NFKC').toLocaleLowerCase().includes(key));
}
export function insertBotMention(text: string, query: BotMentionQuery, name: string): { text: string; caret: number } {
  const inserted = '@' + name + ' ', tail = text.slice(query.end).replace(/^[ \t]/u, '');
  const before = text.slice(0, query.start), prefix = /[\p{L}\p{N}_@.+-]$/u.test(before) ? before + ' ' : before;
  return { text: prefix + inserted + tail, caret: prefix.length + inserted.length };
}
