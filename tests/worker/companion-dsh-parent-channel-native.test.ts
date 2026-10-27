import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createNativeAcceptanceBroker } from '../helpers/companion-dsh-native-broker';
import { installedDshAcceptanceProgram } from '../helpers/companion-dsh-real-route';

it.skipIf(process.platform !== 'win32' || !existsSync(path.join(process.env.APPDATA ?? '', 'WorldlineBox/dsh/runtimes.json'))).each(['native', 'ptc'] as const)(
  'carries a real DSH checkpoint to the parent before completion and accepts a targeted correction in %s mode', async mode => {
    let blocked: ServerResponse | undefined, requestCount = 0;
    const requests: string[] = [];
    const answer = (response: ServerResponse | undefined, text: string, report?: object, toolName = 'report_to_parent') => {
      if (!response || response.destroyed || response.writableEnded) return;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const content = report ? { type: 'tool_use', id: 'report-' + requestCount, name: toolName, input: report } : { type: 'text', text };
      const delta = report ? { type: 'input_json_delta', partial_json: JSON.stringify(report) } : { type: 'text_delta', text };
      const events = [
        { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: report ? { ...content, input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta }, { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: report ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
      ];
      response.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''));
    };
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const wire = JSON.parse(body), text = JSON.stringify(wire.messages);
      // Native title generation is independent of the executing Agent's tool-enabled requests.
      if (!JSON.stringify(wire.tools ?? []).includes(mode === 'ptc' ? 'run_code' : 'report_to_parent')) { answer(response, '网页设计任务'); return; }
      requests.push(text); requestCount++;
      if (text.includes('CONTINUE_OLD_SESSION')) {
        expect(text).toContain('网页布局草稿已完成'); expect(text).toContain('PARENT_TARGETED_CORRECTION');
        answer(response, '沿用原网页任务和蓝色主题，已继续核对。');
      } else if (requestCount === 1) {
        expect(JSON.stringify(wire)).toContain('report_to_parent');
        const report = { kind: 'checkpoint', text: '网页布局草稿已完成，等待主脑决定配色。' };
        answer(response, '', mode === 'ptc' ? { code: `return await tools.report_to_parent(${JSON.stringify(report)});`, description: '回传网页检查点' } : report,
          mode === 'ptc' ? 'run_code' : 'report_to_parent');
      } else if (requestCount === 2) answer(response, '', mode === 'ptc'
        ? { code: 'return await tools.wait_for_parent({timeoutMs:600000});', description: '等待主脑配色决定' } : { timeoutMs: 600000 }, mode === 'ptc' ? 'run_code' : 'wait_for_parent');
      else if (text.includes('PARENT_TARGETED_CORRECTION')) answer(response, '已按主脑更正采用蓝色主题。');
      else blocked = response;
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
    const native = await createNativeAcceptanceBroker({ program: await installedDshAcceptanceProgram(), apiKey: 'fixture-only', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${address.port}/v1` });
    try {
      const operation = native.operation();
      const execution = native.broker.execute({ prompt: '制作一个网页；布局完成时通过report_to_parent报告检查点并请求配色决定。', timeoutMs: 45000 }, operation,
        { ...native.execution, companionName: '主脑双向通道验收', task: { mode, ...(mode === 'native' ? { tools: [] } : {}) } });
      let failure: unknown; void execution.catch(error => { failure = error; });
      await vi.waitFor(() => { if (failure) throw failure; expect(native.broker.events(operation.id).some(event => event.type === 'parent_report')).toBe(true); }, { timeout: 30000 });
      expect(native.broker.state().find(record => record.id === operation.id)?.status).toBe('running');
      const report = native.broker.events(operation.id).find(event => event.type === 'parent_report')!;
      expect(JSON.parse(report.text!)).toEqual({ kind: 'checkpoint', text: '网页布局草稿已完成，等待主脑决定配色。' });
      await vi.waitFor(() => {
        if (failure) throw new Error(String(failure) + '\n' + JSON.stringify(native.broker.events(operation.id).slice(-8)));
        expect(native.broker.events(operation.id).some(event => event.toolName === 'wait_for_parent'
          || event.toolName === 'run_code' && event.text?.includes('wait_for_parent')), JSON.stringify({ requestCount, events: native.broker.events(operation.id).slice(-8) })).toBe(true);
      }, { timeout: 10000 });
      expect(requestCount).toBe(2);
      await native.broker.sendInput(operation.id, 'PARENT_TARGETED_CORRECTION 请采用蓝色主题。', 'steer', 'parent-targeted-message');
      const first = await execution; expect(first.text).toContain('按主脑更正');
      const archive = await native.broker.readRecord({ recordId: operation.id, start: 1, end: 50 });
      expect(JSON.stringify(archive)).toContain('网页布局草稿');
      expect(requests.some(text => text.includes('PARENT_TARGETED_CORRECTION'))).toBe(true);
      const previous = native.broker.state().find(record => record.id === operation.id)!;
      const beforeClient = await native.instances.ensureHost(native.instance.id);
      const beforeGroup = await beforeClient.request<{ workspace: { id: string; title: string } }>('/sessions', {
        sessionId: previous.sessionId, cwd: previous.sessionWorkspacePath, workspaceTitle: '主脑双向通道验收', resume: true,
      });
      await native.instances.stop(native.instance.id);
      const resumed = await native.broker.execute({ prompt: 'CONTINUE_OLD_SESSION 请沿之前的会话继续核对网页任务。', timeoutMs: 45000 }, native.operation(), {
        ...native.execution, companionName: '主脑双向通道验收', task: { mode, session: { mode: 'resume', taskId: operation.id } },
      });
      expect(resumed.sessionId).toBe(first.sessionId); expect(resumed.workspacePath).toBe(first.workspacePath);
      expect(resumed.text).toContain('沿用原网页任务');
      const afterClient = await native.instances.ensureHost(native.instance.id);
      const afterGroup = await afterClient.request<{ workspace: { id: string; title: string; sessionIds: string[] } }>('/sessions', {
        sessionId: resumed.sessionId, cwd: previous.sessionWorkspacePath, workspaceTitle: '主脑双向通道验收', resume: true,
      });
      expect(afterGroup.workspace).toMatchObject({ id: beforeGroup.workspace.id, title: '主脑双向通道验收', sessionIds: [first.sessionId] });
    } finally { answer(blocked, 'fixture cleanup'); await native.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 90000,
);
