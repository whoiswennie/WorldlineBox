import type { CompanionAgendaOccurrence, CompanionAgendaRule, CompanionAgendaRun, CompanionAgendaView } from '../../shared/companion-agenda';
import { companionCivilInstantInZone, companionTimeInZone, nextCompanionScheduleRun } from '../../shared/companion-schedule-time';

export type AgendaViewName = 'today' | 'upcoming' | 'goals' | 'history';
export interface AgendaEntry { key: string; rule: CompanionAgendaRule; occurrence?: CompanionAgendaOccurrence; run?: CompanionAgendaRun; at?: string; endAt?: string; planned: boolean; observedAt?: string }
export const agendaKindLabels: Record<CompanionAgendaRule['kind'], string> = { self: '自我唤醒', chat: '交流', world: '世界活动', research: '探索与研究', learning: '学习', memory: '整理经历', reflection: '回顾与联想', rest: '作息', reminder: '提醒', work: '约定的工作', observation: '观察', growth: '成长与练习' };
/** Native-reference presentation is a read-only host projection, never a rule draft. */
export const agendaRuleTitle = (rule: CompanionAgendaRule): string => rule.presentation?.title ?? rule.title;
export const agendaRuleIntent = (rule: CompanionAgendaRule): string => rule.presentation?.intent ?? rule.intent;
const runLabels: Record<CompanionAgendaRun['status'], string> = { queued: '等待开始', running: '正在进行', waiting: '等待条件', completed: '已完成', silent: '维持现状', cancelled: '已停止', parked: '已搁置', abandoned: '已放弃', unknown: '结果待核对' };
const occurrenceLabels: Record<CompanionAgendaOccurrence['state'], string> = { observing: '机会窗口', ready: '已到条件', waiting: '等待条件', running: '正在进行', completed: '已完成', silent: '保持安静', expired: '窗口已结束', cancelled: '已停止', parked: '已搁置', abandoned: '已放弃', unknown: '结果待核对' };
const terminal = new Set(['completed', 'silent', 'expired', 'cancelled', 'abandoned']);
export function agendaDayKey(value: string | number): string { const day = new Date(value); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; }
export function agendaDayRange(day: string) { const start = new Date(day + 'T00:00:00'), end = new Date(start); end.setDate(end.getDate() + 1); return { from: start.toISOString(), to: end.toISOString() }; }
export function agendaMoveDay(day: string, amount: number): string { const date = new Date(day + 'T12:00:00'); date.setDate(date.getDate() + amount); return agendaDayKey(date.getTime()); }
export function agendaClock(value: string): string { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); }
export function agendaFullTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); }
export function agendaResultText(value: string): { text?: string; raw?: string } {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') return { text: parsed };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const parts = [...new Set(['summary', 'text', 'reason'].flatMap(key => typeof record[key] === 'string' && record[key].trim() ? [record[key] as string] : []))];
      return { ...(parts.length ? { text: parts.join('\n') } : {}), raw: value };
    }
    return { raw: value };
  } catch { return { text: value }; }
}
export function agendaEntryStatus(entry: AgendaEntry): string {
  if (entry.run) return runLabels[entry.run.status];
  if (entry.occurrence) return occurrenceLabels[entry.occurrence.state];
  if (entry.rule.status === 'paused') return '未来安排已暂停';
  if (entry.rule.status === 'retired') return '安排已结束';
  if (entry.rule.executor === 'routine') return '日常生活窗口';
  if (entry.at && entry.observedAt && Date.parse(entry.at) < Date.parse(entry.observedAt) && entry.rule.trigger.kind !== 'window') return '已到点，待检查';
  return entry.rule.trigger.kind === 'window' ? '机会窗口' : entry.rule.trigger.kind === 'event' ? '条件触发' : '已安排';
}
export function agendaTriggerLabel(rule: CompanionAgendaRule): string {
  const trigger = rule.trigger;
  if (rule.clock === 'world' && trigger.kind === 'window') {
    const at = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    return `世界时间 ${at(trigger.startMinute)} — ${at(trigger.endMinute)}`;
  }
  if (trigger.kind === 'window') return `窗口基础机会 ${new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 }).format(trigger.probability)}`;
  if (trigger.kind === 'event') return trigger.quietSeconds ? `新事件稳定 ${trigger.quietSeconds} 秒后检查` : '真实事件触发';
  if (trigger.kind === 'interval') return `每 ${trigger.everyMinutes} 分钟考虑`;
  return { once: '指定时点', daily: '每天', weekly: '每周', monthly: '每月' }[trigger.repeat];
}
export function agendaEntryDescription(entry: AgendaEntry): string { return entry.run?.nextCondition || entry.run?.stage || entry.rule.presentation?.intent || entry.occurrence?.reason || entry.rule.reason; }
function intersects(start: string, end: string | undefined, from: number, to: number, ongoing = false) { return Date.parse(start) < to && (end ? Date.parse(end) > from : ongoing || Date.parse(start) >= from); }

/** Calendar candidates are read-only labels. They never create an occurrence,
 * settle probability or invent a Run in order to fill a visual time slot. */
export function agendaCandidate(rule: CompanionAgendaRule, day: string): Pick<AgendaEntry, 'at' | 'endAt'> | undefined {
  const bounds = agendaDayRange(day), from = Date.parse(bounds.from), to = Date.parse(bounds.to), trigger = rule.trigger;
  if (trigger.kind === 'event') return {};
  if (trigger.kind === 'window') {
    const civil = companionTimeInZone(from, trigger.timeZone);
    // The view is a local day. Check adjacent civil dates to include an
    // overnight window and rules whose zone differs from the display zone.
    for (let offset = -1; offset <= 1; offset++) {
      const date = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + offset));
      if (trigger.weekDays && !trigger.weekDays.includes(date.getUTCDay())) continue;
      const startCivil = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: Math.floor(trigger.startMinute / 60), minute: trigger.startMinute % 60, second: 0, millisecond: 0 };
      const endDate = new Date(date); if (trigger.endMinute <= trigger.startMinute || trigger.endMinute === 1440) endDate.setUTCDate(endDate.getUTCDate() + 1);
      const endCivil = { year: endDate.getUTCFullYear(), month: endDate.getUTCMonth() + 1, day: endDate.getUTCDate(), hour: Math.floor(trigger.endMinute % 1440 / 60), minute: trigger.endMinute % 60, second: 0, millisecond: 0 };
      const start = companionCivilInstantInZone(startCivil, trigger.timeZone), end = companionCivilInstantInZone(endCivil, trigger.timeZone);
      if (start !== undefined && end !== undefined && start < to && end > from) return { at: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
    }
    return undefined;
  }
  const timing = trigger.kind === 'interval' ? { runAt: trigger.anchorAt, timeZone: trigger.timeZone, recurrence: 'interval' as const, intervalMinutes: trigger.everyMinutes }
    : { runAt: trigger.at, timeZone: trigger.timeZone, recurrence: trigger.repeat, weekDays: trigger.weekDays };
  const at = nextCompanionScheduleRun(timing, new Date(from - 1));
  return at && Date.parse(at) < to ? { at } : undefined;
}
export function agendaEntries(data: CompanionAgendaView, view: AgendaViewName, day: string): AgendaEntry[] {
  const result: AgendaEntry[] = [], bounds = agendaDayRange(day), from = Date.parse(bounds.from), to = Date.parse(bounds.to);
  for (const sourceRule of data.rules) {
    const rule = sourceRule.clock === 'world' && sourceRule.trigger.kind === 'window' && data.worldTime
      ? { ...sourceRule, trigger: { ...sourceRule.trigger, timeZone: data.worldTime.timeZone } } : sourceRule;
    if (rule.companionId !== data.companionId) continue;
    const allOccurrences = data.occurrences.filter(item => item.ruleId === rule.id && item.companionId === data.companionId);
    const recurring = rule.trigger.kind !== 'at' || rule.trigger.repeat !== 'once';
    const active = allOccurrences.filter(item => !terminal.has(item.state));
    const occurrences = recurring && view !== 'history' ? active.length ? active : allOccurrences.slice().sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)).slice(0, 1) : allOccurrences;
    for (const occurrence of occurrences) {
      const run = data.runs.filter(item => item.occurrenceId === occurrence.id && item.companionId === data.companionId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const done = terminal.has(occurrence.state) || !!run && terminal.has(run.status);
      if (view === 'history' && !done || view === 'upcoming' && done) continue;
      const at = run?.startedAt ?? occurrence.scheduledAt, endAt = run ? run.finishedAt : occurrence.windowEnd;
      if ((view === 'today' || view === 'history') && !intersects(at, endAt, from, to, !!run && !terminal.has(run.status))) continue;
      result.push({ key: occurrence.id, rule, occurrence, run, at, endAt, planned: false });
    }
    if (view === 'history' || rule.status === 'retired' || rule.trigger.kind === 'at' && rule.trigger.repeat === 'once' && occurrences.length) continue;
    const candidate = view === 'today' ? rule.nextAt && recurring && rule.trigger.kind !== 'window' && agendaDayKey(data.observedAt) === day
      ? Date.parse(rule.nextAt) >= from && Date.parse(rule.nextAt) < to ? { at: rule.nextAt } : undefined : agendaCandidate(rule, day) : rule.trigger.kind === 'event' ? {} : rule.nextAt ? { at: rule.nextAt }
      : rule.status === 'paused' && rule.trigger.kind === 'at' ? { at: rule.trigger.at } : agendaCandidate(rule, day);
    if (!candidate) continue;
    if (result.some(item => item.rule.id === rule.id && (rule.trigger.kind === 'event' || rule.trigger.kind === 'at' && rule.trigger.repeat === 'once' || !candidate.at || item.occurrence?.scheduledAt === candidate.at))) continue;
    result.push({ key: `rule:${rule.id}`, rule, ...candidate, planned: true, observedAt: data.observedAt });
  }
  return result.sort((a, b) => (a.at ?? '\uffff').localeCompare(b.at ?? '\uffff') || a.key.localeCompare(b.key));
}
export interface AgendaEntryGroup { key: string; at?: string; parallel: boolean; entries: AgendaEntry[] }
export function agendaEntryGroups(entries: readonly AgendaEntry[]): AgendaEntryGroup[] {
  const groups: AgendaEntryGroup[] = [];
  for (const entry of entries) {
    const live = entry.run?.status === 'running';
    const key = live && entry.at ? `running:${agendaDayKey(entry.at)}` : entry.at ? entry.at.slice(0, 16) : `conditional:${entry.key}`;
    let group = groups.find(item => item.key === key);
    if (!group) { group = { key, at: entry.at, parallel: false, entries: [] }; groups.push(group); }
    group.entries.push(entry); group.parallel = group.entries.length > 1 && group.entries.every(item => item.run?.status === 'running');
  }
  return groups;
}
