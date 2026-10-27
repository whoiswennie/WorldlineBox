import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createNativeAcceptanceBroker } from '../helpers/companion-dsh-native-broker';
import { installedDshAcceptanceProgram } from '../helpers/companion-dsh-real-route';

it.skipIf(process.platform !== 'win32' || !existsSync(path.join(process.env.APPDATA ?? '', 'WorldlineBox/dsh/runtimes.json')))(
  'uses one real DSH partner group across separate Sessions and accepts guidance while another loop completes', async () => {
    let first: ServerResponse | undefined, sawGuidance = false; const prompts: string[] = [];
    const answer = (response: ServerResponse, text: string) => {
      if (!response || response.destroyed || response.writableEnded) return;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const events = [
        { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      response.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
    };
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const wire = JSON.parse(body), serialized = JSON.stringify(wire.messages); prompts.push(serialized);
      if (serialized.includes('GUIDE_NEW_GOAL')) { sawGuidance = true; answer(response, '已按新要求展示原文件，停止播放。'); }
      else if (serialized.includes('TASK_SLOW') && !first) first = response;
      else answer(response, serialized.includes('TASK_OTHER') ? '独立任务完成。' : '原阶段已结束。');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
    const native = await createNativeAcceptanceBroker({ program: await installedDshAcceptanceProgram(), apiKey: 'fixture-only', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${address.port}/v1` });
    try {
      const slow = native.operation(), other = native.operation();
      const execution = { ...native.execution, companionName: '分组引导测试', recordScope: { ...native.execution.recordScope!, invocationId: 'first-loop' } };
      const pending = native.broker.execute({ prompt: 'TASK_SLOW 检查文件，等待后续引导。', timeoutMs: 30000 }, slow, execution);
      // Attach a handler immediately so a failed Host cannot produce an unhandled rejection.
      let taskFailure: unknown; void pending.catch(error => { taskFailure = new Error(String(error) + '\n' + JSON.stringify(native.broker.events(slow.id).slice(-6))); });
      await vi.waitFor(() => { if (taskFailure) throw taskFailure; expect(first).toBeDefined(); }, { timeout: 30000 });
      const second = await native.broker.execute({ prompt: 'TASK_OTHER 独立任务。', timeoutMs: 30000 }, other,
        { ...execution, recordScope: { ...execution.recordScope, invocationId: 'other-loop' } });
      expect(second.text).toContain('独立任务完成');
      await native.broker.sendInput(slow.id, 'GUIDE_NEW_GOAL 不要播放，展示原文件。', 'steer', 'guidance-message');
      answer(first!, '原阶段结束，需按最新用户消息继续。');
      const result = await pending;
      expect(sawGuidance).toBe(true); expect(result.text).toContain('按新要求');
      expect(result.workspacePath).not.toBe(second.workspacePath);
      const records = native.broker.state(); expect(records).toHaveLength(2);
      expect(new Set(records.map(record => record.sessionWorkspacePath)).size).toBe(1);
      const client = await native.instances.ensureHost(native.instance.id);
      const views = await Promise.all(records.map(record => client.request<{ workspace: { id: string; sessionIds: string[] } }>('/sessions', {
        sessionId: record.sessionId, cwd: record.sessionWorkspacePath, workspaceTitle: '分组引导测试', resume: true,
      })));
      expect(views[0]!.workspace.id).toBe(views[1]!.workspace.id);
      expect(views[0]!.workspace.sessionIds).toEqual(expect.arrayContaining(records.map(record => record.sessionId)));
      expect(prompts.length).toBeGreaterThanOrEqual(3);
    } finally { answer(first!, 'fixture cleanup'); await native.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 90000,
);
