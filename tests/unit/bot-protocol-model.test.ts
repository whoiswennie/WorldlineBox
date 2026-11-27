import { expect, it } from 'vitest';
import { startBotProtocolModel } from '../fixtures/bot-protocol-model';

it('selects the live diary tool for a changed preference before a trailing native user notice', async () => {
  const model = await startBotProtocolModel();
  try {
    const response = await fetch(model.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tools: [{ type: 'function', function: { name: 'memory_write' } }], messages: [
        { role: 'system', content: '伙伴根据经历自主写日记。' },
        { role: 'user', content: [{ type: 'text', text: JSON.stringify({ message: { content: '晚上喝麦茶，上午仍喝咖啡。' } }) }] },
        { role: 'user', content: 'Native context notice.' },
      ] }) });
    expect(response.ok).toBe(true); const wire = await response.text(); expect(wire).toContain('memory_write'); expect(wire).toContain('麦茶');
    expect(model.counters.diaryWrites).toBe(1);
  } finally { await model.close(); }
});
