// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { BotReplyTiming } from '../../src/renderer/companion-bot/BotReplyTiming';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('shows measured reply time and available stages, and does not invent timing for older messages', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(() => root.render(<BotReplyTiming locale="zh-CN" timing={{ elapsedMs: 12400, queueMs: 1500, prepareMs: 200, firstTextMs: 4800, modelMs: 10000 }} />));
    expect(host.textContent).toContain('用时 12.4 秒');
    expect(host.querySelector('span')?.title).toContain('排队 1.5 秒');
    expect(host.querySelector('span')?.title).toContain('准备 200 毫秒');
    expect(host.querySelector('span')?.title).not.toContain('收尾');
    await act(() => root.render(<BotReplyTiming locale="zh-CN" />)); expect(host.textContent).toBe('');
    await act(() => root.render(<BotReplyTiming locale="zh-CN" timing={{ elapsedMs: Number.NaN }} />)); expect(host.textContent).toBe('');
  } finally { await act(() => root.unmount()); host.remove(); }
});
