import http from 'node:http';
import process from 'node:process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const name = 'worldlinebox-bridge';
export const inject = ['loader', 'sessionController', 'workspaceRegistry', 'agents', 'sessions', 'tools', 'agentPresets'];
const protocol = 'worldlinebox-native-web-host-v1';
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** A normal profile plugin. Native Web owns Agents, presets, policy and persistence. */
export async function apply(ctx) {
  const token = process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN;
  delete process.env.WORLDLINEBOX_DSH_BRIDGE_TOKEN;
  // A user may also launch this profile through the official CLI.
  if (!token) return;
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('The WorldlineBox Host capability is invalid.');
  const sessions = new Map(), requests = new Map(), clients = new Set();
  let closing = false;
  const authorized = request => {
    const value = request.headers.authorization;
    return typeof value === 'string' && /^Bearer [a-f0-9]{64}$/.test(value)
      && timingSafeEqual(Buffer.from(value), Buffer.from('Bearer ' + token));
  };
  const recordFor = agent => {
    const seen = new Set();
    while (agent && !seen.has(agent.id)) {
      const owned = sessions.get(String(agent.session.id));
      if (owned) return owned;
      seen.add(agent.id); agent = ctx.agents.get(agent.session.header.parentSession);
    }
  };
  const emit = (record, event) => {
    const value = { sequence: record.next++, receivedAt: new Date().toISOString(), sessionId: record.id, ...event };
    record.events.push(value);
    record.eventBytes += Buffer.byteLength(JSON.stringify(value));
    while (record.events.length > 8000 || record.eventBytes > 8 * 1024 * 1024) {
      record.eventBytes -= Buffer.byteLength(JSON.stringify(record.events.shift()));
    }
    for (const client of record.clients) {
      if (client.writableLength > 2 * 1024 * 1024) { client.destroy(); continue; }
      client.write(JSON.stringify(value) + '\n');
    }
  };
  const service = agent => agent.ctx.get('skills');
  const capabilities = async (record, query = { kind: 'overview' }) => {
    const agent = record.agent;
    const allTools = ctx.tools.schemas(agent);
    const tools = record.policy.cognitiveOnly ? [] : allTools.filter(tool => !record.policy.tools || record.policy.tools.includes(tool.name));
    const provider = service(agent);
    const allSkills = provider ? await provider.list({ cwd: record.cwd, scope: agent }) : [];
    const skills = record.policy.cognitiveOnly ? [] : allSkills.filter(skill => !record.policy.skills || record.policy.skills.includes(skill.name));
    const effective = { digest: createHash('sha256').update(JSON.stringify({ preset: record.preset, tools, skills })).digest('hex'),
      mode: record.preset === 'ptc' ? 'ptc' : 'native', preset: record.preset, toolCount: tools.length, skillCount: skills.length };
    let detail;
    if (query.kind === 'tool') detail = { kind: 'tool', name: query.name, available: tools.some(tool => tool.name === query.name),
      tool: tools.find(tool => tool.name === query.name), source: 'native-agent-scope', trust: 'capability_reference_data' };
    if (query.kind === 'skill') {
      const skill = skills.some(skill => skill.name === query.name) ? await provider.get(query.name, { cwd: record.cwd, scope: agent }) : undefined;
      const content = skill?.content ?? '', offset = query.textOffset ?? 0, end = Math.min(content.length, offset + (query.maxChars ?? 16000));
      detail = { kind: 'skill', name: query.name, available: !!skill, source: 'native-agent-scope', trust: 'capability_reference_data',
        ...(skill ? { skill: { name: skill.name, description: skill.description, provider: skill.provider, source: skill.source, path: skill.path,
          resourceBase: skill.resourceBase, content: content.slice(offset, end), textOffset: offset, totalChars: content.length,
          truncated: end < content.length, ...(end < content.length ? { nextTextOffset: end } : {}) } } : {}) };
    }
    if (query.kind === 'commands') {
      const entries = ctx.get('commands')?.list(agent) ?? [];
      const selected = query.name ? entries.filter(entry => entry.name === query.name) : entries;
      detail = { kind: 'commands', available: true, source: 'native-agent-scope', trust: 'capability_reference_data',
        commands: selected.slice(0, 100), totalCommands: selected.length, truncated: selected.length > 100, commandsExecutable: false };
    }
    return { modes: ['native', ...((await ctx.agentPresets.list()).some(preset => preset.id === 'ptc') ? ['ptc'] : [])], preset: record.preset,
      tools: tools.slice(0, 500).map(tool => ({ name: tool.name, description: String(tool.description ?? '').slice(0, 2000) })),
      skills: skills.slice(0, 500).map(skill => ({ name: skill.name, description: String(skill.description ?? '').slice(0, 2000) })),
      toolsTotal: tools.length, skillsTotal: skills.length, truncated: tools.length > 500 || skills.length > 500,
      toolRestrictions: typeof ctx.tools.guard === 'function', skillSelection: true, effective, ...(detail ? { detail } : {}) };
  };
  const settle = async record => {
    if (record.waiting) return;
    record.waiting = true;
    try {
      while (!closing) {
        const revision = record.revision;
        await record.agent.whenIdle();
        if (await ctx.get('subagents')?.waitForChildren?.(record.agent)) continue;
        const sequence = record.agent.session.seq;
        await wait(25);
        if (revision !== record.revision || record.agent.status !== 'idle' || sequence !== record.agent.session.seq) continue;
        await ctx.sessions.flush(record.agent.session);
        record.status = record.cancelled ? 'cancelled' : record.reason?.kind === 'completed' ? 'succeeded' : 'failed';
        emit(record, { type: 'complete', status: record.status, text: record.text, reason: record.reason, artifacts: record.artifacts });
        break;
      }
    } catch (error) {
      record.status = 'failed'; emit(record, { type: 'complete', status: 'failed', error: String(error), text: record.text });
    } finally { record.waiting = false; }
  };
  ctx.on('session/event', (session, event) => {
    const record = sessions.get(String(session.id));
    if (!record) return;
    const data = event.data;
    switch (event.type) {
      case 'turn/start': emit(record, { type: 'status', stage: 'turn_start', summary: '开始处理任务' }); break;
      case 'step/start': emit(record, { type: 'status', stage: 'step_start', summary: `开始第 ${data.step} 步处理` }); break;
      case 'step/end': emit(record, { type: 'status', stage: 'step_end', summary: `第 ${data.step} 步处理结束` }); break;
      case 'turn/end': record.reason = data.reason; emit(record, { type: 'status', stage: 'turn_end', summary: '本轮处理结束' }); break;
      case 'tool/call': emit(record, { type: 'tool_call', stage: 'tool_start', toolName: data.name, callId: data.callId,
        text: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments), contentKind: 'input', summary: '开始调用工具' }); break;
      case 'tool/result':
        if (event.surfaceOp === undefined || event.surfaceOp === 'append') emit(record, { type: 'tool_result', stage: 'tool_end', callId: data.message.toolCallId,
          text: textOf(data.message), contentKind: 'output', summary: data.message.isError ? '工具执行失败' : '工具执行完成' });
        break;
      case 'assistant/message': record.text = textOf(data.message); emit(record, { type: 'text', stage: 'message', text: record.text, contentKind: 'message', outputState: 'committed' }); break;
      case 'deliverables/presented': record.artifacts = data.files; emit(record, { type: 'artifacts', artifacts: data.files }); break;
    }
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const record = sessions.get(String(agent.session.id));
    if (!record) return;
    if (frame.type === 'start') { record.stream = ''; record.streamId = randomUUID(); }
    else if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
      record.stream += frame.chunk.text;
      if (Date.now() - record.lastPublish > 100) {
        record.lastPublish = Date.now(); emit(record, { type: 'text_stream', text: record.stream, streamId: record.streamId, outputState: 'draft' });
      }
    }
  });
  ctx.on('agent/error', ({ agent, error }) => {
    const record = sessions.get(String(agent.session.id));
    if (record) { record.reason = { kind: 'error' }; emit(record, { type: 'error', text: String(error), stage: 'failed' }); }
  });
  // Restrict only explicitly selected/cognitive tasks and their descendants.
  // Normal Web and partner sessions retain the complete native plugin catalog.
  ctx.effect(() => ctx.tools.guard(execution => {
    const record = recordFor(execution.agent);
    if (!record) return;
    if (record.policy.cognitiveOnly) return 'This task is computation only; tool execution is unavailable.';
    if (record.policy.tools && !record.policy.tools.includes(execution.name)) return 'This tool is outside the task selection.';
    if (execution.name === 'skill' && record.policy.skills && !record.policy.skills.includes(execution.arguments?.name)) return 'This skill is outside the task selection.';
  }));
  const create = async input => {
    if (typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.sessionId)
      || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) throw new Error('Invalid native Session identity or workspace.');
    if (input.workspaceTitle !== undefined && (typeof input.workspaceTitle !== 'string' || !input.workspaceTitle.trim() || input.workspaceTitle.length > 100)) throw new Error('Invalid companion workspace title.');
    const workspace = input.workspaceTitle === undefined ? undefined : await ctx.workspaceRegistry.create(input.cwd, input.workspaceTitle.trim());
    if (workspace && workspace.title !== input.workspaceTitle.trim()) await workspace.setTitle(input.workspaceTitle.trim());
    const existing = sessions.get(input.sessionId) ?? requests.get(input.sessionId);
    if (existing) {
      if (workspace) { await workspace.attachSession(existing.id); existing.workspace = workspace; }
      return existing;
    }
    const preset = input.preset ?? ctx.agentPresets.defaultId;
    // Native create can replace a nonblank Session. Resume must use resolveAgent,
    // the same public entry used by the Web UI to reopen a persisted conversation.
    const sessionId = input.resume ? input.sessionId : (await ctx.sessionController.create({ sessionId: input.sessionId,
      ...(workspace ? { workspaceId: workspace.id } : { cwd: input.cwd }), agentPreset: preset })).sessionId;
    const found = await ctx.sessionController.resolveAgent(sessionId);
    if (found.error) throw found.error;
    if (workspace) await workspace.attachSession(sessionId);
    const actualPreset = ctx.get('sessionProjections')?.stateOf(found.agent.session, 'agentPreset') ?? preset;
    const record = { id: String(sessionId), cwd: input.cwd, workspace, preset: actualPreset, agent: found.agent, policy: input.policy ?? {}, events: [], clients: new Set(),
      next: 0, revision: 0, status: 'idle', text: '', stream: '', lastPublish: 0, artifacts: [], disposers: [], eventBytes: 0 };
    sessions.set(record.id, record); requests.set(input.sessionId, record);
    try {
    if (record.policy.cognitiveOnly || record.policy.tools) {
      const allow = record.policy.cognitiveOnly ? [] : record.policy.tools;
      const actual = ctx.tools.schemas(record.agent);
      for (const tool of allow) if (!actual.some(entry => entry.name === tool)) throw new Error('Unknown native tool: ' + tool);
      record.disposers.push(record.agent.ctx.tools.restrict({ allow }));
      record.disposers.push(record.agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next(); return { ...assembled, tools: (assembled.tools ?? []).filter(tool => allow.includes(tool.name)) };
      }, { prepend: true }));
    }
    if (record.policy.skills && !record.policy.cognitiveOnly) {
      const registry = service(record.agent), catalog = registry ? await registry.list({ cwd: record.cwd, scope: record.agent }) : [];
      for (const name of record.policy.skills) if (!catalog.some(skill => skill.name === name)) throw new Error('Unknown native skill: ' + name);
      // Native scoped registrations shadow only this Agent's unselected entries.
      // The global registry and the user's Web Sessions remain untouched.
      for (const skill of catalog) if (!record.policy.skills.includes(skill.name)) record.disposers.push(registry.register({
        name: skill.name, description: skill.description, content: '', source: 'runtime', invocation: { modelInvocable: false, userInvocable: false },
      }));
    }
    if (input.accessMode !== undefined) {
      if (!['read-only', 'workspace-write', 'danger-full-access'].includes(input.accessMode)) throw new Error('Invalid Session permission mode.');
      record.agent.session.append('sandbox/mode', { mode: input.accessMode });
    }
    emit(record, { type: 'ready', stage: 'session', summary: '已接入原生 Web Host 会话' });
    return record;
    } catch (error) {
      for (const dispose of record.disposers) dispose();
      sessions.delete(record.id); requests.delete(input.sessionId); throw error;
    }
  };
  const json = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const body = async request => {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Bridge request exceeds the input limit.'); chunks.push(chunk); }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      if (!authorized(request)) { json(response, { error: 'Unauthorized' }, 401); return; }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') { json(response, { protocol, pid: process.pid, profile: ctx.get('profileContext')?.name, home: process.env.DSH_HOME }); return; }
      if (request.method === 'POST' && url.pathname === '/shutdown') {
        closing = true; json(response, { accepted: true }); setTimeout(() => process.emit('SIGTERM'), 20); return;
      }
      if (request.method === 'POST' && url.pathname === '/companions/reset') {
        const input = await body(request);
        if (!Array.isArray(input.sessionIds) || input.sessionIds.some(id => typeof id !== 'string')
          || !Array.isArray(input.workspacePaths) || input.workspacePaths.some(cwd => typeof cwd !== 'string' || !path.isAbsolute(cwd))) throw new Error('Invalid reset scope.');
        const owned = new Set(input.sessionIds);
        const workspaces = ctx.workspaceRegistry.list().filter(workspace => input.workspacePaths.some(cwd => path.resolve(cwd) === path.resolve(workspace.path)));
        for (const workspace of workspaces) for (const id of workspace.sessionIds) owned.add(String(id));
        for (const id of owned) {
          const record = sessions.get(id);
          if (record) {
            if (record.status === 'running') await ctx.sessionController.cancel({ sessionId: record.id }, new AbortController().signal);
            await record.agent.whenIdle();
            while (await ctx.get('subagents')?.waitForChildren?.(record.agent)) await record.agent.whenIdle();
            await ctx.sessions.flush(record.agent.session);
          }
          await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true });
          if (record) { for (const dispose of record.disposers) dispose(); sessions.delete(id); }
          for (const [key, value] of requests) if (value.id === id) requests.delete(key);
        }
        for (const workspace of workspaces) await ctx.workspaceRegistry.delete(workspace.id);
        json(response, { archived: [...owned], removedWorkspaces: workspaces.map(workspace => workspace.id) }); return;
      }
      if (request.method === 'POST' && url.pathname === '/sessions') {
        const record = await create(await body(request));
        json(response, { sessionId: record.id, cursor: record.next - 1, pid: process.pid, capabilities: await capabilities(record),
          ...(record.workspace ? { workspace: { id: record.workspace.id, title: record.workspace.title, path: record.workspace.path, sessionIds: record.workspace.sessionIds } } : {}),
          accessMode: ctx.get('sandboxPolicy')?.resolve({ session: record.agent.session }).mode }); return;
      }
      if (request.method === 'POST' && url.pathname === '/capabilities') {
        const input = await body(request);
        const preset = input.preset ?? ctx.agentPresets.defaultId;
        const record = await create({ sessionId: input.sessionId + '-' + preset, cwd: input.cwd, preset });
        json(response, await capabilities(record, input.query)); return;
      }
      if (request.method === 'POST' && url.pathname === '/plugins') {
        const input = await body(request), manager = ctx.get('pluginManager');
        if (!manager) throw new Error('This native profile has no plugin manager.');
        const requestId = randomUUID();
        const disconnected = () => { if (!response.writableEnded && input.action === 'add') void manager.cancelInstall(requestId).catch(() => undefined); };
        response.once('close', disconnected);
        try {
          const value = input.action === 'add' ? await manager.installBundle(input.spec, { requestId })
            : input.action === 'remove' ? await manager.removeBundle(input.spec)
            : input.action === 'toggle' ? await manager.setBundleEnabled(input.spec, input.enabled) : await manager.listBundles();
          json(response, value); return;
        } finally { response.removeListener('close', disconnected); }
      }
      const match = /^\/sessions\/([A-Za-z0-9_-]+)\/(events|prompt|cancel|capabilities)$/.exec(url.pathname);
      const record = match && sessions.get(match[1]);
      if (!record) { json(response, { error: 'Unknown native Session' }, 404); return; }
      if (request.method === 'GET' && match[2] === 'events') {
        const after = Number(url.searchParams.get('after') ?? -1);
        if (!Number.isSafeInteger(after) || after < -1 || record.events[0]?.sequence > after + 1) throw new Error('Native event stream cursor is unavailable.');
        response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
        for (const event of record.events) if (event.sequence > after) response.write(JSON.stringify(event) + '\n');
        record.clients.add(response); clients.add(response);
        response.on('close', () => { record.clients.delete(response); clients.delete(response); }); return;
      }
      if (request.method === 'POST' && match[2] === 'prompt') {
        const input = await body(request);
        if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 65536) throw new Error('Invalid native prompt.');
        if (record.status !== 'running') { record.text = ''; record.reason = undefined; record.artifacts = []; }
        record.revision++; record.status = 'running'; record.cancelled = false;
        const accepted = await ctx.sessionController.prompt({ sessionId: record.id, requestId: input.messageId ?? randomUUID(), mode: input.mode ?? 'queue',
          content: [{ type: 'text', text: input.prompt }], clientTimeZone: 'Asia/Shanghai' }, new AbortController().signal);
        json(response, accepted); void settle(record); return;
      }
      if (request.method === 'POST' && match[2] === 'cancel') {
        record.cancelled = true;
        if (record.status === 'running') await ctx.sessionController.cancel({ sessionId: record.id }, new AbortController().signal);
        await record.agent.whenIdle();
        while (await ctx.get('subagents')?.waitForChildren?.(record.agent)) await record.agent.whenIdle();
        await ctx.sessions.flush(record.agent.session);
        json(response, { accepted: true }); return;
      }
      if (request.method === 'GET' && match[2] === 'capabilities') { json(response, await capabilities(record)); return; }
      json(response, { error: 'Unknown bridge operation' }, 404);
    })().catch(error => {
      if (!response.headersSent) json(response, { error: String(error?.message ?? error) }, 500);
      else response.destroy();
    });
  });
  ctx.effect(() => async () => {
    closing = true;
    for (const record of sessions.values()) for (const dispose of record.disposers) dispose();
    for (const client of clients) client.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  // Readiness follows native Loader settlement; listening alone is insufficient.
  void ctx.loader.await().then(() => process.stdout.write(`WORLDLINEBOX_DSH_BRIDGE_READY ${address.port}\n`));
}
