import { useEffect, useState, type ReactNode } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorldStatus } from '../../shared/companion-world';
import { COMPANION_CONTACT_LABELS } from '../../shared/companion-contact';
import { Icon } from '../Icons';
import { COMPANION_WEATHER_LABELS, companionWeatherSymbol } from '../../shared/companion-weather';

/** Reads the simulation clock; interpolation uses its speed and never sets it to wall time. */
export function CompanionWorldStatus({ api, members, companions, active, onObserve, children }: {
  api?: WorldlineBoxCompanionsApi; members: Companion[]; companions: Companion[]; active: boolean;
  onObserve(companionId?: string, conversationId?: string): void;
  children?: (parts: { clock: ReactNode; activity: ReactNode }) => ReactNode;
}) {
  const [sample, setSample] = useState<{ value: CompanionWorldStatus; received: number }>();
  const [elapsed, setElapsed] = useState(0);
  const ids = members.map(member => member.id).sort().join(',');
  useEffect(() => {
    if (!api || !active) return;
    let alive = true, pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const response = await api.request({ type: 'world.status', companionIds: ids ? ids.split(',') : [] });
        if (alive && response.ok && response.worldStatus) { setSample({ value: response.worldStatus, received: performance.now() }); setElapsed(0); }
      } catch { /* Preserve the last observed instant on a temporary disconnection. */ }
      finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    document.addEventListener('visibilitychange', load);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [api, active, ids]);
  useEffect(() => {
    if (!sample || !active) return;
    const timer = setInterval(() => { if (!document.hidden) setElapsed(Math.min(2500, Math.max(0, performance.now() - sample.received))); }, 250);
    return () => clearInterval(timer);
  }, [sample, active]);
  const clock = sample?.value.clock;
  const virtualAt = clock ? new Date(Date.parse(clock.virtualNow) + (clock.backlog ? 0 : elapsed * clock.speed)) : undefined;
  const time = virtualAt && clock ? new Intl.DateTimeFormat('zh-CN', { timeZone: clock.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(virtualAt) : '—:—:—';
  const date = virtualAt && clock ? new Intl.DateTimeFormat('zh-CN', { timeZone: clock.timeZone, month: '2-digit', day: '2-digit' }).format(virtualAt) : '';
  const environment = sample?.value.environment;
  const weather = environment?.weather;
  const weatherLabel = weather ? COMPANION_WEATHER_LABELS[weather] : '天气未知';
  const temperature = environment?.outdoorTemperature;
  const localHour = virtualAt && clock ? Number(new Intl.DateTimeFormat('en-US', { timeZone: clock.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(virtualAt)) : 12;
  const interaction = sample?.value.interactions.find(item => members.some(member => member.id === item.companionId));
  const name = (id: string) => id === 'user' ? '你' : companions.find(member => member.id === id)?.name ?? '伙伴';
  const targets = interaction?.recipientIds.map(name).join('、');
  const phase = interaction?.phase;
  const action = phase === 'queued' ? `准备联系${targets}` : phase === 'waiting' ? `等待${targets}回复` : phase === 'notification' ? `收到${targets}的消息` : phase === 'typing' || phase === 'responding' ? `正在给${targets}回消息` : phase === 'speaking' || phase === 'listening' ? `正在和${targets}交谈` : '';
  const phaseLabel = phase === 'queued' ? '待发送' : phase === 'waiting' ? '等待' : phase === 'notification' ? '来信' : phase === 'typing' || phase === 'responding' ? '回复' : '交谈';
  const waiting = interaction?.recipients.filter(recipient => recipient.state !== 'available');
  const reason = waiting?.map(recipient => `${name(recipient.companionId)}${COMPANION_CONTACT_LABELS[recipient.state]}`).join('；');
  const dormant = members.length > 0 && members.every(member => member.active === false);
  const clockView = <span className="companions-world-clock" aria-label="虚拟世界信息">
    <Icon name="clock" /><span className="companions-world-clock-caption">世界</span>
    <time aria-label="虚拟世界时间" dateTime={virtualAt?.toISOString()} title={clock ? `世界时区 ${clock.timeZone} · ${clock.mode === 'compressed' ? `${clock.speed} 倍时间` : '实时模式'}${clock.backlog ? ' · 正在接续存档' : ''}` : '正在读取虚拟世界时间'}>
      <strong>{time}</strong><span className="companions-world-clock-date">{date}</span>
    </time>
    {environment && <span className="companions-world-weather" aria-label="虚拟世界天气" title={`虚拟世界当前天气：${weatherLabel}${temperature !== undefined ? ` · 室外 ${temperature.toFixed(1)}°C` : ''}；伙伴感知取决于实际观察。`}>
      <span aria-hidden="true">{companionWeatherSymbol(weather, localHour >= 6 && localHour < 18)}</span><span>{weatherLabel}</span>
      {temperature !== undefined && <span className="companions-world-weather-temperature">{temperature.toFixed(1)}°C</span>}
    </span>}
  </span>;
  const detail = [dormant ? '伙伴已休眠，世界未加载' : action, reason, '查看伙伴交流记录'].filter(Boolean).join('\n');
  const activity = <button className="companions-world-activity" data-engaged={!!interaction} type="button" aria-label="查看此伙伴的交互" title={detail} onClick={() => onObserve(interaction?.companionId ?? members[0]?.id, interaction?.conversationId)}>
    <Icon name="users" />{interaction && <span>{targets} · {phaseLabel}</span>}
  </button>;
  return children ? children({ clock: clockView, activity }) : <div className="companions-world-status" aria-label="伙伴虚拟世界状态">{clockView}{activity}</div>;
}
