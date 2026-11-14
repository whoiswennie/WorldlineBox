import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTopics } from '../../src/main/companion-bot/topics';
import { BotSchedules, hasActiveSchedules, nextScheduleTime } from '../../src/main/companion-bot/schedules';
import type { ScheduleDraft } from '../../src/shared/companion-schedule';

it('advances daily schedules at local clock time and intervals from the dispatch time', () => {
  const day = new Date(2026, 10, 13, 19, 59, 59).getTime();
  const daily = { kind: 'daily' as const, time: '20:00' };
  const due = nextScheduleTime(daily, day);
  expect(due).toBe(new Date(2026, 10, 13, 20).getTime());
  expect(nextScheduleTime(daily, due)).toBe(new Date(2026, 10, 14, 20).getTime());
  expect(nextScheduleTime({ kind: 'interval', minutes: 15 }, due)).toBe(due + 900000);
});

it('persists schedules, catches up once, preserves the active topic and scopes edits to the owner', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wlb-schedule-'));
  const db = path.join(root, 'bot.sqlite');
  let store = new BotStore(db);
  try {
    store.createCompanion({ id: 'schedule-owner', name: '日程伙伴', persona: '按日程执行。' });
    store.createCompanion({ id: 'other-owner', name: '其他伙伴', persona: '独立的日程。' });
    const room = store.openDirect('schedule-owner');
    const active = new BotTopics(store).create(room.id, 'user-topic', '当前聊天');
    let schedules = new BotSchedules(store, new BotTopics(store));
    const draft: ScheduleDraft = { title: '喂鱼', prompt: '用小屋世界喂鱼', enabled: true, recurrence: { kind: 'interval', minutes: 1 } };
    const entry = schedules.manage('schedule-owner', { operation: 'save', draft }, 1000).items.find(item => item.title === draft.title)!;
    expect(hasActiveSchedules(db)).toBe(false);
    expect(schedules.tick(90000)).toBeUndefined();
    expect(() => schedules.manage('other-owner', { operation: 'delete', id: entry!.id })).toThrow();
    schedules.manage('schedule-owner', { operation: 'settings', enabled: true }, 1000);
    expect(hasActiveSchedules(db)).toBe(true);
    store.close();
    store = new BotStore(db);
    const topics = new BotTopics(store);
    schedules = new BotSchedules(store, topics);
    expect(schedules.tick(3600000)).toEqual({ kind: 'check-cabin' });
    expect(schedules.tick(3600000, true)).toEqual({ kind: 'queued', room: room.id });
    expect(schedules.tick(3600000)).toBeUndefined();
    expect(topics.current(room.id)?.id).toBe(active.id);
    const after = schedules.manage('schedule-owner', { operation: 'list' }).items.find(item => item.id === entry.id)!;
    expect(after.nextAt).toBe(3660000);
    expect(after.lastRun?.topicId).not.toBe(active.id);
    expect(after.lastRun?.status).toBe('queued');
    expect(store.messagesPage(room.id).items.filter(message => message.senderId === 'schedule')).toHaveLength(1);
    const edited = schedules.manage('schedule-owner', { operation: 'save', id: after.id, draft: { ...draft, prompt: '用小屋世界看鱼' } }, 3600010).items.find(item => item.id === entry.id)!;
    expect(edited.nextAt).toBe(after.nextAt);
    expect(edited.prompt).toBe('用小屋世界看鱼');
    expect(schedules.manage('schedule-owner', { operation: 'delete', id: edited.id }).items.map(item => item.id)).not.toContain(edited.id);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

it('treats presets as editable paused schedules and skips offline runs without enqueueing a turn', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wlb-schedule-offline-'));
  const store = new BotStore(path.join(root, 'bot.sqlite'));
  try {
    store.createCompanion({ id: 'owner', name: '伙伴', persona: '按日程执行。' });
    const schedules = new BotSchedules(store, new BotTopics(store));
    const presets = schedules.manage('owner', { operation: 'list' }).items;
    expect(presets).toHaveLength(3);
    expect(presets.every(item => !item.enabled)).toBe(true);
    const id = presets[2]!.id;
    schedules.manage('owner', { operation: 'save', id, draft: { title: '喂鱼', prompt: '调用 cabin_use 给鱼喂食', enabled: true, recurrence: { kind: 'interval', minutes: 1 } } }, 1000);
    schedules.manage('owner', { operation: 'settings', enabled: true }, 1000);
    expect(schedules.tick(61000)).toEqual({ kind: 'check-cabin' });
    expect(schedules.tick(61000, false)).toEqual({ kind: 'skipped' });
    expect(schedules.manage('owner', { operation: 'list' }).items.find(item => item.id === id)).toMatchObject({ nextAt: 121000, lastRun: { status: 'skipped', reason: 'cabin-offline' } });
    expect(store.messagesPage(store.openDirect('owner').id).items).toEqual([]);
    schedules.manage('owner', { operation: 'delete', id });
    expect(schedules.manage('owner', { operation: 'list' }).items).toHaveLength(2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
