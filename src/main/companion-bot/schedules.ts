import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { cabinSchedulePresets, scheduleDraft, scheduleUsesCabin, type CompanionSchedule, type CompanionScheduleState, type ScheduleCommand, type ScheduleDraft } from '../../shared/companion-schedule';
import type { BotStore } from './store';
import type { BotTopics } from './topics';

const source = 'companion-schedule';
const key = (id: string) => `companion-schedule:${id}`;

export function hasActiveSchedules(file: string): boolean {
  if (!existsSync(file)) return false;
  const ReadonlyDatabase = Database as new (filename: string, options: { readonly: boolean; fileMustExist: boolean }) => BotScheduleReader;
  const db = new ReadonlyDatabase(file, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_metadata'").get()) return false;
    return !!db.prepare("SELECT 1 FROM bot_metadata WHERE key GLOB 'companion-schedule:*' AND json_extract(value,'$.enabled')=1 LIMIT 1").get();
  } finally { db.close(); }
}
interface BotScheduleReader { prepare(sql: string): { get(): unknown }; close(): void }

export function nextScheduleTime(recurrence: ScheduleDraft['recurrence'], after: number): number {
  if (recurrence.kind === 'interval') return after + recurrence.minutes * 60000;
  const [hours, minutes] = recurrence.time.split(':').map(Number);
  const next = new Date(after);
  next.setHours(hours!, minutes!, 0, 0);
  if (next.getTime() <= after) {
    next.setDate(next.getDate() + 1);
    next.setHours(hours!, minutes!, 0, 0);
  }
  return next.getTime();
}

type Entry = Omit<CompanionSchedule, 'lastRun'> & { last?: { at: number; topicId: string; eventId: string } | { at: number; skipped: 'cabin-offline' } };
type Settings = { enabled: boolean; items: Entry[]; presetsAdded?: boolean };

export class BotSchedules {
  constructor(private readonly store: BotStore, private readonly topics: BotTopics) {}

  private read(id: string): Settings {
    const json = this.store.getMetadata(key(id));
    return this.withPresets(json ? JSON.parse(json) as Settings : { enabled: false, items: [] });
  }

  private withPresets(settings: Settings): Settings {
    if (!settings.presetsAdded) {
      for (const [index, preset] of cabinSchedulePresets.entries()) {
        if (settings.items.length >= 64) break;
        if (!settings.items.some(item => item.title === preset.title && scheduleUsesCabin(item))) {
          settings.items.push({ ...preset, id: `cabin-preset-${index}`, enabled: false, nextAt: 0 });
        }
      }
      settings.presetsAdded = true;
    }
    return settings;
  }

  manage(id: string, command: ScheduleCommand, now = Date.now()): CompanionScheduleState {
    if (!this.store.getCompanion(id)) throw Error('伙伴不存在。');
    return this.store.taskTransaction(() => {
      const settings = this.read(id);
      const index = 'id' in command && command.id ? settings.items.findIndex(item => item.id === command.id) : -1;
      if ('id' in command && command.id && index < 0) throw Error('这位伙伴没有这项日程。');
      if (command.operation === 'settings' && settings.enabled !== command.enabled) {
        settings.enabled = command.enabled;
        if (settings.enabled) for (const item of settings.items) item.nextAt = nextScheduleTime(item.recurrence, now);
      }
      if (command.operation === 'save') {
        const draft = scheduleDraft.parse(command.draft), current = settings.items[index];
        if (!current && settings.items.length >= 64) throw Error('每位伙伴最多保存 64 项日程。');
        const keepTime = current?.enabled === draft.enabled && JSON.stringify(current.recurrence) === JSON.stringify(draft.recurrence);
        const item = { ...current, ...draft, id: current?.id ?? randomUUID(), nextAt: keepTime ? current.nextAt : nextScheduleTime(draft.recurrence, now) };
        if (current) settings.items[index] = item; else settings.items.push(item);
      }
      if (command.operation === 'toggle') {
        const item = settings.items[index]!;
        if (item.enabled !== command.enabled) {
          item.enabled = command.enabled;
          item.nextAt = nextScheduleTime(item.recurrence, now);
        }
      }
      if (command.operation === 'delete') settings.items.splice(index, 1);
      if (command.operation !== 'list') this.store.setMetadata(key(id), JSON.stringify(settings));
      return { enabled: settings.enabled, items: settings.items.map(({ last, ...item }) => ({ ...item,
        ...(last ? { lastRun: 'skipped' in last ? { at: last.at, status: 'skipped', reason: last.skipped }
          : { at: last.at, topicId: last.topicId, status: this.store.getEvent(last.eventId)?.status ?? 'unknown' } } : {}),
      })) };
    });
  }

  skipQueued(companionId: string, scheduleId: unknown, eventId: string, now = Date.now()) {
    this.store.taskTransaction(() => {
      const settings = this.read(companionId), item = settings.items.find(entry => entry.id === scheduleId);
      if (item?.last && 'eventId' in item.last && item.last.eventId === eventId) {
        item.last = { at: now, skipped: 'cabin-offline' };
        this.store.setMetadata(key(companionId), JSON.stringify(settings));
      }
      this.store.cancelEvent(eventId);
    });
  }

  tick(now = Date.now(), cabinOnline?: boolean): { kind: 'check-cabin' } | { kind: 'skipped' } | { kind: 'queued'; room: string } | undefined {
    return this.store.taskTransaction(sql => {
      const active = sql.prepare("SELECT companion_id AS id,json_extract(payload_json,'$.cabinWorld') AS cabin FROM bot_inbox WHERE source_instance_id=? AND status IN ('queued','running')").all(source) as Array<{ id: string; cabin: number | null }>;
      const busy = new Set(active.map(run => run.id));
      const cabinBusy = active.some(run => run.cabin);
      const rows = sql.prepare("SELECT key,value FROM bot_metadata WHERE key GLOB 'companion-schedule:*' AND json_extract(value,'$.enabled')=1 ORDER BY key").all() as Array<{key: string; value: string}>;
      const due = rows.flatMap(row => {
        const id = row.key.slice('companion-schedule:'.length), companion = this.store.getCompanion(id);
        if (!companion || companion.enabled === false || busy.has(id)) return [];
        const settings = this.withPresets(JSON.parse(row.value) as Settings);
        return settings.items.filter(item => item.enabled && item.nextAt <= now && !(cabinBusy && scheduleUsesCabin(item))).map(item => ({ id, key: row.key, item, settings }));
      }).sort((a, b) => a.item.nextAt - b.item.nextAt)[0];
      if (due) {
        const { id, item, settings } = due;
        const cabinWorld = scheduleUsesCabin(item);
        if (cabinWorld && cabinOnline === undefined) return { kind: 'check-cabin' };
        if (cabinWorld && !cabinOnline) {
          item.last = { at: now, skipped: 'cabin-offline' };
          item.nextAt = nextScheduleTime(item.recurrence, now);
          this.store.setMetadata(due.key, JSON.stringify(settings));
          return { kind: 'skipped' };
        }
        const room = this.store.openDirect(id);
        const runId = `${item.id}:${item.nextAt}`;
        const topic = this.topics.create(room.id, runId, `日程 · ${item.title}`, false);
        const result = this.store.enqueue({ conversationId: room.id, recipientIds: [id], source: 'schedule', senderId: 'schedule', senderName: '日程',
          sourceInstanceId: source, sourceMessageId: runId, content: item.prompt,
          payload: { scheduleId: item.id, scheduleTitle: item.title, cabinWorld } });
        this.topics.bind(result.events, topic);
        item.last = { at: now, eventId: result.events[0]!.id, topicId: topic.id };
        item.nextAt = nextScheduleTime(item.recurrence, now);
        this.store.setMetadata(due.key, JSON.stringify(settings));
        return { kind: 'queued', room: room.id };
      }
      return undefined;
    });
  }
}
