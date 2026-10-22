import { useEffect, useRef } from 'react';
import type { Companion } from '../../shared/companions';
import { CompanionStatusBadge } from './CompanionStatusBadge';
import { Avatar } from './CompanionVisuals';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
export function CompanionPresencePanel({ members, onConfigure, onClose }: { members: Companion[]; onConfigure: (role: Companion) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(true, '伙伴状态');
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !ref.current?.contains(event.target) && !(event.target instanceof Element && event.target.closest('[data-presence-trigger]'))) onClose(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [onClose]);
  return <div ref={ref} className="companions-presence-panel" role="dialog" aria-modal="true" aria-label="伙伴状态" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <header><strong>伙伴状态</strong><button className="companion-icon-button" aria-label="关闭伙伴状态" onClick={onClose}>×</button></header>
    <div>{members.map(role => <article key={role.id} data-presence-role={role.id}><Avatar companion={role} /><div><strong>{role.name}<CompanionStatusBadge companion={role} /></strong><p>{role.active === false ? '虚拟世界未加载，后台活动已暂停。请在联系人资料中手动激活。' : role.availability === 'offline' ? role.availabilityReason || '尚未连接模型服务，消息会保存在本地' : role.availability === 'working' ? `${role.activeCount ?? 1} 条回复正在进行${role.queuedCount ? ` · ${role.queuedCount} 条等待中` : ''}` : role.availability === 'waiting' ? `${role.queuedCount ?? 1} 条消息等待空闲位置` : '可以聊天，也可以交给她处理事情'}</p><button onClick={() => onConfigure(role)}>{role.llm ? '配置伙伴连接' : '全局模型设置'}</button></div></article>)}</div>
  </div>;
}
