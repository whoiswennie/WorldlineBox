import type { DshTaskSpec, DshTaskCapabilityQuery } from '../../shared/dsh-task-spec';

/** Data-only controls embedded in a private, per-invocation native plugin. */
export interface DshRuntimeTaskPolicy {
  /** Main-only thought isolation, enforced independently of advertised tools. */
  cognitiveOnly?: boolean;
  mode?: DshTaskSpec['mode']; tools?: string[]; skills?: string[]; discover?: boolean;
  discoveryQuery?: DshTaskCapabilityQuery;
  expectedEffectiveDigest?: string;
}

/** Native registry restrictions plus a final executor guard, including nested/subagent calls. */
export function taskRuntimePolicySource(policy: DshRuntimeTaskPolicy): string {
  return `const taskPolicy = { ...(io.policy || ${JSON.stringify(policy)}) };\n` + String.raw`
  const cognitiveOnly = taskPolicy.cognitiveOnly === true;
  if (cognitiveOnly) { taskPolicy.mode = 'native'; taskPolicy.tools = []; taskPolicy.skills = []; }
  let taskPrelude = '';
  let taskScope, validateTaskTools = () => {};
  const publishTaskCapabilities = async subject => {
    validateTaskTools();
    const registry = ctx.get('tools'), skills = ctx.get('skills'), scope = taskScope || subject.ctx;
    const allowed = taskPolicy.tools === undefined ? undefined : new Set(taskPolicy.tools);
    const management = new Set(['plugin_manager']);
    const catalog = registry.schemas(subject).filter(tool => !management.has(tool.name) && (!allowed || allowed.has(tool.name)));
    const entries = skills ? await skills.list({ cwd, scope: subject }) : [];
    const { createHash } = require('node:crypto');
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
    const skillContracts = [];
    for (const entry of entries) {
      const definition = await skills.get(entry.name, { cwd, scope: subject });
      if (!definition) throw Error('task/unsupported: effective skill could not be loaded');
      skillContracts.push({ name: entry.name, provider: definition.provider, content: definition.content });
    }
    const effective = { digest: createHash('sha256').update(JSON.stringify(canonical({ mode: taskPolicy.mode || 'native',
      tools: [...catalog].sort((a,b) => a.name.localeCompare(b.name)), skills: skillContracts.sort((a,b) => a.name.localeCompare(b.name)) }))).digest('hex'),
      mode: taskPolicy.mode || 'native', preset: taskPolicy.mode === 'ptc' ? 'ptc' : 'standard', toolCount: catalog.length, skillCount: entries.length };
    if (cognitiveOnly && (effective.mode !== 'native' || effective.toolCount !== 0 || effective.skillCount !== 0))
      throw Error('task/unsupported: cognitive task capabilities are not empty');
    if (taskPolicy.expectedEffectiveDigest && taskPolicy.expectedEffectiveDigest !== effective.digest)
      throw Error('task/unsupported: continued session capabilities changed; start a new session with explicit handoff');
    const rows = await ctx.get('agentPresets').list();
    const modes = ['native'];
    if (rows.some(row => row.id === 'ptc') && ctx.get('ptcRuntime')) modes.push('ptc');
    const query = taskPolicy.discoveryQuery || { kind: 'overview' };
    let detail;
    if (query.kind === 'tool') {
      const tool = catalog.find(item => item.name === query.name && !management.has(item.name));
      detail = { kind: 'tool', name: query.name, available: !!tool, tool, source: 'native-agent-scope', trust: 'capability_reference_data' };
    } else if (query.kind === 'skill') {
      const definition = skills ? await skills.get(query.name, { cwd, scope: subject }) : undefined;
      const textOffset = query.textOffset || 0, maxChars = query.maxChars || 16000;
      if (definition) {
        const content = String(definition.content || '');
        const end = Math.min(content.length, textOffset + maxChars);
        detail = { kind: 'skill', name: query.name, available: true, source: 'native-agent-scope', trust: 'capability_reference_data',
          skill: { name: definition.name, description: definition.description, provider: definition.provider, source: definition.source, path: definition.path,
            resourceBase: definition.resourceBase, content: content.slice(textOffset, end), textOffset, totalChars: content.length, truncated: end < content.length,
            ...(end < content.length ? { nextTextOffset: end } : {}) } };
      } else detail = { kind: 'skill', name: query.name, available: false, source: 'native-agent-scope', trust: 'capability_reference_data' };
    } else if (query.kind === 'commands') {
      const commands = ctx.get('commands');
      const descriptors = commands && typeof commands.list === 'function' ? commands.list(subject) : [];
      const selected = query.name ? descriptors.filter(item => item.name === query.name) : descriptors;
      const { execFile } = await import('node:child_process');
      const help = await new Promise((resolve, reject) => execFile(process.execPath, ['--expose-internals', process.argv[1], '--help'],
        { cwd, env: process.env, windowsHide: true, timeout: 10000, maxBuffer: 128*1024, encoding: 'utf8' }, (error, stdout) => error ? reject(Error('task/unsupported: native CLI help is unavailable')) : resolve(stdout)));
      detail = { kind: 'commands', available: !!commands, source: 'native-agent-scope', trust: 'capability_reference_data',
        commands: selected.slice(0,100), totalCommands: selected.length, truncated: selected.length > 100, commandsExecutable: false,
        cli: { help, source: 'native-cli --help', modes } };
    }
    emit({ type: 'capabilities', modes, preset: taskPolicy.mode === 'ptc' ? 'ptc' : 'standard', effective,
      ...(detail ? { detail } : {}),
      tools: catalog.filter(item => !management.has(item.name)).slice(0,100).map(item => ({ name: item.name, description: String(item.description || '').slice(0,500) })),
      skills: entries.slice(0,100).map(item => ({ name: item.name, description: String(item.description || '').slice(0,500) })),
      toolsTotal: catalog.filter(item => !management.has(item.name)).length, skillsTotal: entries.length, truncated: catalog.length > 100 || entries.length > 100,
      toolRestrictions: typeof registry.guard === 'function' && typeof scope.tools.restrict === 'function', skillSelection: !!skills });
  };

  const configureTask = async (scope, subject) => {
    taskScope = scope;
    const registry = ctx.get('tools'), skills = ctx.get('skills');
    if (!registry || typeof registry.schemas !== 'function') throw Error('task/unsupported: native tool catalog is unavailable');
    if (cognitiveOnly) {
      if (typeof registry.guard !== 'function' || typeof scope.on !== 'function' || !skills
        || typeof skills.list !== 'function' || typeof skills.get !== 'function')
        throw Error('task/unsupported: this runtime cannot enforce cognitive task isolation');
      cleanup.push(registry.guard(() => 'All tool dispatch is disabled for this cognitive-only task.'));
    }
    const catalog = registry.schemas(subject);
    const entries = skills ? await skills.list({ cwd, scope: subject }) : [];
    const management = new Set(['plugin_manager']);
    const blocked = catalog.filter(item => management.has(item.name)).map(item => item.name);
    if (blocked.length && (typeof registry.guard !== 'function' || typeof scope.tools.restrict !== 'function')) throw Error('task/unsupported: plugin management cannot be isolated');
    if (blocked.length) cleanup.push(scope.tools.restrict({ deny: blocked }));
    if (typeof registry.guard === 'function') cleanup.push(registry.guard(exec => management.has(exec.name) ? 'Plugin management belongs to the host configuration interface.' : undefined));
    const allowed = taskPolicy.tools === undefined ? undefined : new Set(taskPolicy.tools);
    if (allowed) {
      if (typeof registry.guard !== 'function' || typeof scope.tools.restrict !== 'function') throw Error('task/unsupported: this runtime cannot enforce tool selection');
      validateTaskTools = () => {
        const current = registry.schemas(subject);
        const unknown = [...allowed].filter(name => !catalog.some(tool => tool.name === name) && !current.some(tool => tool.name === name));
        if (unknown.length) throw Error('task/unsupported: unknown tools: '+unknown.join(', '));
      };
      if ([...allowed].some(name => management.has(name))) throw Error('task/unsupported: plugin management is host-owned');
      // run_code is presentation transport, never an end capability. Nested calls still pass the global guard.
      cleanup.push(scope.tools.restrict({ allow: [...allowed].filter(name => name !== 'run_code' && catalog.some(tool => tool.name === name)) }));
      cleanup.push(registry.guard(exec => exec.name !== 'run_code' && !allowed.has(exec.name) ? 'This tool is outside the task tool selection.' : undefined));
    }
    // Some preset plugins append prompt tools outside the registry's scoped catalog.
    // Filter the final native assembly as well as enforcing every actual dispatch.
    if (typeof scope.on === 'function') cleanup.push(scope.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next();
      return { ...assembled, tools: cognitiveOnly ? [] : assembled.tools?.filter(tool => !management.has(tool.name) && (!allowed || tool.name === 'run_code' || allowed.has(tool.name))) };
    }, { prepend: true }));
    if (taskPolicy.skills !== undefined) {
      if (!skills) throw Error('task/unsupported: skill selection is unavailable');
      const selected = new Set(taskPolicy.skills);
      for (const name of selected) if (!entries.some(item => item.name === name)) throw Error('task/unsupported: unknown skill: '+name);
      const originalList = skills.list, originalGet = skills.get, originalSnapshot = skills.snapshot;
      cleanup.push(() => { skills.list = originalList; skills.get = originalGet; skills.snapshot = originalSnapshot; });
      skills.list = async options => (await originalList.call(skills, options)).filter(item => selected.has(item.name));
      skills.get = async (name, options) => selected.has(name) ? originalGet.call(skills, name, options) : undefined;
      if (typeof originalSnapshot === 'function') skills.snapshot = async options => { const snapshot = await originalSnapshot.call(skills, options); return { ...snapshot, skills: snapshot.skills.filter(item => selected.has(item.name)) }; };
      for (const name of selected) {
        const definition = await skills.get(name, { cwd, scope: subject });
        if (!definition) throw Error('task/unsupported: selected skill could not be loaded: '+name);
        taskPrelude += '\nSelected skill '+name+':\n'+definition.content+'\n';
      }
      if (Buffer.byteLength(taskPrelude) > 512*1024) throw Error('Selected skill instructions exceed the task context limit.');
      if (typeof registry.guard === 'function') cleanup.push(registry.guard(exec => exec.name === 'skill' && !selected.has(exec.arguments?.name) ? 'This skill is outside the task skill selection.' : undefined));
    }
  };
`;
}
