import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

function jsonEnvelope(text: string, marker: string): Record<string, unknown> | undefined {
  const start = text.lastIndexOf(marker); if (start < 0) return;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) { try { return JSON.parse(text.slice(start, index + 1)); } catch { return; } }
  }
}

/** Deterministic wire fixture for integration only. Its replies are not model
 * quality evidence. Real DSH executes every returned tool call. */
export async function startBotProtocolModel() {
  const counters = { requests: 0, toolCalls: 0, captures: 0, capturedPreference: 0, summaries: 0 };
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      counters.requests++;
      const plain = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value)
        ? value.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : '';
      const messages: Array<{ role: string; content?: unknown; name?: string }> = data.messages;
      const system = messages.filter(message => message.role === 'system').map(message => plain(message.content)).join('\n');
      let lastUser = messages.findLastIndex(message => message.role === 'user');
      let current = plain(messages[lastUser]?.content);
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role !== 'user') continue;
        const envelope = jsonEnvelope(plain(messages[index]!.content), '{"envelope":');
        const trigger = envelope?.trigger as { content?: unknown } | undefined;
        if (typeof trigger?.content === 'string') { current = trigger.content; lastUser = index; break; }
      }
      const suffix = messages.slice(lastUser + 1);
      const have = (name: string) => suffix.some(message => message.role === 'tool' && (message.name === name || JSON.stringify(message).includes(name)));
      const priorTools = suffix.filter(message => message.role === 'tool').length;
      let content = '你好，伙伴主脑已经接入。', call: { name: string; args: object } | undefined;
      if (messages.some(message => plain(message.content).includes('You are now acting as a compaction engine'))) {
        counters.summaries++;
        content = '## Primary Request and Intent\n- Continue the companion validation conversation.\n## Key Technical Concepts\n- Native sessions, VCP recall and delegated task receipts.\n## Files and Code\n- cedar-proof.txt is the task artifact; inspect task status before claiming completion.\n## Errors and Fixes\n- None.\n## Pending Jobs\n- Use durable task records for current progress.\n## Current Work\n- Verify test project code through memory.\n## Next Step\n- Respond to the latest user message.\n## Critical Context\n- Test project code 青榆舟. Evening preference 麦茶; morning coffee remains allowed.';
      } else if (system.includes('最多6条') && system.includes('notes')) {
        counters.captures++;
        // Encoder jobs have separate Sessions. Locate this job's source
        // envelope even if the native preset appends another user notice.
        const envelope = messages.filter(message => message.role === 'user').map(message => plain(message.content))
          .find(value => jsonEnvelope(value, '{"sourceEventId":')?.sourceMessages) ?? current;
        if (envelope.includes('晚上喝麦茶')) counters.capturedPreference++;
        content = JSON.stringify({ notes: envelope.includes('晚上喝麦茶') ? [{ content: '开发验收偏好：从此次更新起，晚上喝麦茶，上午仍喝咖啡；不表示全天不喝咖啡。', tags: ['验收', '偏好'] }] : [] });
      } else if (system.includes('DSH执行器')) {
        if (priorTools === 0) call = { name: 'write', args: { file_path: 'cedar-proof.txt', content: 'WLB_SUPER_AGENT_OK' } };
        else if (priorTools === 1) call = { name: 'read', args: { file_path: 'cedar-proof.txt' } };
        else content = '已创建 cedar-proof.txt，并实际读取验证。';
      } else if (current.includes('请实际调用 dsh_task')) {
        if (!have('dsh_task') && priorTools === 0) call = { name: 'dsh_task', args: { title: '验收文件', goal: '在本任务工作区创建 cedar-proof.txt，内容为 WLB_SUPER_AGENT_OK，再读取文件核验。' } };
        else content = '任务已提交，等待实际任务回执。';
      } else if (current.includes('请先调用 memory_search')) {
        if (priorTools === 0) call = { name: 'memory_search', args: { query: '测试项目代号' } };
        else content = '根据本次检索资料，测试项目代号是青榆舟。';
      } else if (current.includes('核对记忆后')) content = '测试项目代号是青榆舟；文件任务的完成状态已在任务回执中记录。';
      else if (current.includes('晚上喝麦茶')) content = '已收到这次带时间和时段范围的偏好更正。';
      else if (current.includes('任务回执')) content = '已收到实际任务回执。';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = call ? { tool_calls: [{ index: 0, id: 'fixture-call-' + randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content };
      if (call) counters.toolCalls++;
      response.write('data: ' + JSON.stringify({ id: 'fixture-response-' + randomUUID(), choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: Math.ceil(JSON.stringify(messages).length / 3), completion_tokens: 50, total_tokens: Math.ceil(JSON.stringify(messages).length / 3) + 50 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No protocol fixture port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, counters,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
