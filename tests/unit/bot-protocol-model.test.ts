import { expect, it } from 'vitest';
import { startBotProtocolModel } from '../fixtures/bot-protocol-model';

it('recognizes this isolated encoder job envelope before a trailing native user notice', async () => {
  const model = await startBotProtocolModel();
  try {
    const response = await fetch(model.baseUrl + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [
        { role: 'system', content: '最多6条 notes' },
        { role: 'user', content: [{ type: 'text', text: JSON.stringify({ sourceEventId: 'current-encoder-job', sourceMessages: [{ content: '晚上喝麦茶，上午仍喝咖啡。' }] }) }] },
        { role: 'user', content: 'Native context notice.' },
      ] }) });
    expect(response.ok).toBe(true); expect(await response.text()).toContain('麦茶');
    expect(model.counters.capturedPreference).toBe(1);
  } finally { await model.close(); }
});
