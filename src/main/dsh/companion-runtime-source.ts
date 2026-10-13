/**
 * Thin CLI plugin over the shipped Agent API, not another agent loop.
 * The native loop owns model calls, tool scheduling, inbox and durable sessions.
 * Main owns the child lifetime; this adapter only projects events and forwards input.
 */
export function companionRuntimeSource(anchor: string, resumeSessionId?: string, recovery?: { id: string; prompt: string; inputs: Array<{ id: string; content: string; mode: 'steer' | 'queue' }> }): string {
  return 'import { createRequire } from "node:module";\nconst require = createRequire(' + JSON.stringify(anchor) + ');\nconst resumeSessionId = ' + JSON.stringify(resumeSessionId ?? null) + ';\nconst recovery = ' + JSON.stringify(recovery ?? null) + ';\n' + String.raw`
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const { installModelSelection } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent')));
export const name = 'worldlinebox-companion-runtime';
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'agentPresets'];
export function apply(ctx) {
  const exit = ctx.get('appExit');
  if (typeof exit !== 'function') throw Error('Companion CLI requires its owning app exit boundary');
  const input = createInterface({ input: process.stdin, terminal: false });
  let agent, started = false, accepting = true, accepted = 0, lastText = '', reason, revision = 0;
  let stream = '', streamId, streamOrdinal = 0, lastPublish = 0, streamTimer, hadLiveText = false;
  let outputState = 'draft'; const toolStreams = new Map();
  const seenInputs = new Set();
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  const flushText = () => {
    clearTimeout(streamTimer); streamTimer = undefined;
    if (stream) { emit({ type: 'text_stream', streamId, text: stream.slice(0, 16000), outputState }); lastPublish = Date.now(); hadLiveText = true; }
    for (const [index, tool] of toolStreams) emit({ type: 'tool_stream', streamId: 'tool_stream_' + streamOrdinal + '_' + index, tool: tool.name, text: tool.text.slice(0, 16000), outputState });
  };
  const finish = async () => {
    // whenIdle follows replacement work; the revision check closes the admission race.
    while (true) {
      const observed = revision;
      await agent.whenIdle();
      await new Promise(resolve => setTimeout(resolve, 50));
      if (observed === revision) break;
    }
    accepting = false; flushText();
    await ctx.get('sessions').flush(agent.session);
    if (reason?.kind && reason.kind !== 'completed') emit({ type: 'error', code: 'task/' + reason.kind });
    emit({ type: 'final', text: lastText || '执行器未返回可读取的结果。' });
    exit(reason?.kind === 'completed' ? 0 : 1);
  };
  const ready = Promise.resolve().then(async () => {
    await ctx.get('loader')?.await();
    const selection = ctx.get('agentDefaultModel').currentSelection();
    const sessionId = resumeSessionId || 'session-' + randomUUID();
    ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId) return;
      const data = event.data;
      switch (event.type) {
        case 'turn/start': emit({ type: 'status', phase: 'turn_start', turn: data.turn }); break;
        case 'step/start': emit({ type: 'status', phase: 'step_start', turn: data.turn, step: data.step }); break;
        case 'step/end': emit({ type: 'status', phase: 'step_end', turn: data.turn, step: data.step }); break;
        case 'turn/end': reason = data.reason; emit({ type: 'status', phase: 'turn_end', turn: data.turn, reason: { kind: data.reason.kind } }); break;
        case 'tool/call': {
          let args; try { args = JSON.parse(data.arguments || '{}'); } catch { args = data.arguments; }
          emit({ type: 'tool_call', callId: data.callId, tool: data.name, input: args }); break;
        }
        case 'tool/result': {
          if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') break;
          const message = data.message;
          emit({ type: 'tool_result', callId: message.toolCallId, status: message.isError ? 'error' : 'completed',
            result: message.content.filter(block => block.type === 'text').map(block => block.text).join('').slice(0, 64000) }); break;
        }
        case 'assistant/message': {
          const text = data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
          if (text) { lastText = text; if (!hadLiveText) emit({ type: 'text', text: text.slice(0, 16000) }); }
          break;
        }
      }
    });
    ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject.id !== sessionId) return;
      if (frame.type === 'start') { if (outputState === 'draft' && (stream || toolStreams.size)) { outputState = 'abandoned'; flushText(); } stream = ''; streamId = 'stream_' + (++streamOrdinal); hadLiveText = false; outputState = 'draft'; toolStreams.clear(); }
      else if (frame.type === 'end') { outputState = frame.outcome?.kind === 'committed' && frame.outcome.eventType === 'assistant/message' ? 'committed' : 'abandoned'; flushText(); }
      else if (frame.chunk.type === 'text-delta') {
        stream += frame.chunk.text;
        if (Date.now() - lastPublish >= 100) flushText();
        else if (!streamTimer) streamTimer = setTimeout(flushText, 100);
      }
      else if (frame.chunk.type === 'tool-call-delta') {
        const chunk = frame.chunk, previous = toolStreams.get(chunk.index) ?? { name: '', text: '' };
        toolStreams.set(chunk.index, { name: chunk.name ?? previous.name, text: previous.text + chunk.argumentsDelta });
        if (Date.now() - lastPublish >= 100) { lastPublish = Date.now(); flushText(); }
        else if (!streamTimer) streamTimer = setTimeout(flushText, 100);
      }
      // Native private reasoning-delta is deliberately excluded.
    });
    const collectInputs = subject => {
      const seen = new Set(), turns = new Map();
      for (let seq = 0; seq < subject.session.seq; seq++) {
        const event = subject.session.eventAt(seq);
        if (event?.type === 'user/message' && event.data?.message?.source?.worldlineboxInputId) {
          const ids = turns.get(event.data.turn) ?? [];
          ids.push(event.data.message.source.worldlineboxInputId); turns.set(event.data.turn, ids);
        }
        if (event?.type === 'turn/end' && event.data.reason?.kind === 'completed') for (const id of turns.get(event.data.turn) ?? []) seen.add(id);
      }
      for (const message of [...subject.inbox.nextStep, ...subject.inbox.nextTurn]) if (message.source?.worldlineboxInputId) seen.add(message.source.worldlineboxInputId);
      return seen;
    };
    const options = { agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (scope, subject) => {
        // Mount the instance's declared standard composition, including user-edited plugins.
        // A host-only catalog is incomplete when the Web profile owns per-Agent presets.
        await ctx.get('agentPresets').mount(scope, 'standard');
        installModelSelection(scope, { current: selection, assembled: undefined });
        if (!recovery) return;
        const seen = collectInputs(subject);
        for (const input of recovery.inputs) if (!seen.has(input.id)) {
          subject.inbox.append(input.mode === 'steer' ? 'next-step' : 'next-turn', createUserMessage({ content: [{type:'text',text:'恢复前未完成的补充要求。先结合原会话证据核对已有操作，只完成尚未达成的部分，禁止盲目重复已完成或结果未知的外部动作：\n'+input.content}],source:{kind:'user',worldlineboxInputId:input.id} }));
          seen.add(input.id);
        }
        // Native maintenance holds the driver: resume the original work before
        // letting its queued next-turn requests run, without replaying inputs.
        if (!seen.has(recovery.id)) subject.inbox.prepend('next-turn', createUserMessage({content:[{type:'text',text:recovery.prompt}],source:{kind:'user',worldlineboxInputId:recovery.id}}));
      } };
    if (resumeSessionId) {
      if (!ctx.get('sessionPersistence') || !ctx.get('sessionQuery')) throw Error('Native durable session services are required for recovery');
      const observation = await ctx.get('sessionQuery').observeSession(sessionId);
      try {
        if (observation.header.cwd !== process.cwd() || observation.header.origin === 'subagent' || observation.header.parentSession) throw Error('Native recovery session does not match this original root task workspace');
      } finally { observation[Symbol.dispose](); }
      agent = (await ctx.get('agents').resume({ ...options, resumeSessionId: sessionId })).agent;
      if (agent.session.header.cwd !== process.cwd()) throw Error('Recovered native session workspace changed');
    } else agent = (await ctx.get('agents').create({ ...options, sessionId, meta: { cwd: process.cwd() } })).agent;
    for (const id of collectInputs(agent)) seenInputs.add(id);
    if (recovery) { seenInputs.add(recovery.id); for (const input of recovery.inputs) seenInputs.add(input.id); }
    emit({ type: 'session', sessionId, resumed: !!resumeSessionId });
    emit({ type: 'ready' });
  });
  let commands = Promise.resolve();
  input.on('line', line => {
    commands = commands.then(async () => {
      await ready;
      if (line.length > 2 * 1024 * 1024) throw Error('Oversized companion input');
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.type === 'cancel') { accepting = false; agent.cancel({ kind: 'user' }, { keepInbox: true }); return; }
      if (!accepting || !['start', 'steer', 'queue'].includes(value.type) || typeof value.content !== 'string' || !value.content.trim() || value.content.length > 65536 || accepted >= 100) {
        emit({ type: 'input_rejected', requestId: value.requestId }); return;
      }
      if (value.type === 'start' && started || value.type !== 'start' && !started) {
        emit({ type: 'input_rejected', requestId: value.requestId }); return;
      }
      const admit = (content, mode, inputId) => {
        if (inputId && seenInputs.has(inputId)) return;
        const message = createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user', ...(inputId ? { worldlineboxInputId: inputId } : {}) } });
        if (mode === 'steer') agent.steer(message); else agent.followup(message);
        if (inputId) seenInputs.add(inputId);
      };
      admit(value.content, value.type, value.sourceInputId);
      if (value.type === 'start' && Array.isArray(value.inputs)) {
        if (value.inputs.length > 100) throw Error('Oversized initial input queue');
        for (const input of value.inputs) {
          if (!['steer', 'queue'].includes(input.mode) || typeof input.content !== 'string' || input.content.length > 16000 || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id)) throw Error('Invalid initial input');
          admit(input.content, input.mode, input.id);
        }
      }
      if (value.type === 'start' && recovery) {
        // Inbox mutations during native factory maintenance are durable but
        // deliberately do not wake its driver. Public steering wakes it while
        // preserving the prepended original task ahead of queued followups.
        agent.steer(createUserMessage({content:[{type:'text',text:'继续已恢复的原任务，按现有队列顺序完成剩余工作，不重复已完成的操作。'}],source:{kind:'user',worldlineboxInputId:recovery.id+'-wake'}}));
      }
      revision++; accepted++;
      await ctx.get('sessions').flush(agent.session);
      emit({ type: 'input_accepted', mode: value.type, requestId: value.requestId });
      if (!started) { started = true; void finish().catch(() => { emit({ type: 'error', code: 'task/runtime' }); exit(1); }); }
    }).catch(() => { emit({ type: 'error', code: 'task/input' }); exit(1); });
  });
  input.on('close', () => { if (agent && accepting) agent.cancel({ kind: 'parent' }, { keepInbox: true }); });
  ctx.effect(() => () => { clearTimeout(streamTimer); accepting = false; input.close(); });
  void ready.catch(error => { emit({ type: 'error', code: 'task/startup', message: String(error?.message || 'Native startup failed').slice(0, 1000) }); exit(1); });
}
`;
}
