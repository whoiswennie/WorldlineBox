import path from 'node:path';

/** DSH groups Sessions by their immutable project cwd. Effective tool cwd is
 * a separate native projection, so parallel tasks can share a visible project
 * without sharing their output directories. */
export function botProjectDirectory(input) {
  if (input.workspaceTitle === undefined) return input.cwd;
  if (typeof input.workspaceTitle !== 'string' || !input.workspaceTitle.trim() || input.workspaceTitle.length > 100) throw new Error('Invalid companion workspace title.');
  const parent = input.workspaceParent;
  if (parent === undefined) return input.cwd;
  if (!parent || typeof parent.path !== 'string' || !path.isAbsolute(parent.path) || typeof parent.title !== 'string'
    || !parent.title.trim() || parent.title.length > 100) throw new Error('Invalid companion workspace parent.');
  const relative = path.relative(parent.path, input.cwd);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Companion workspace parent must contain this task directory.');
  return parent.path;
}

export async function prepareBotWorkspace(ctx, record, input) {
  const project = botProjectDirectory(input), headerCwd = record.agent.session.header.cwd;
  if (![project, input.cwd].some(candidate => path.resolve(candidate) === path.resolve(headerCwd))) throw new Error('Companion Session project ownership differs.');
  if (input.workspaceParent && path.resolve(headerCwd) === path.resolve(project)) {
    const directory = record.agent.ctx.get('workingDirectory');
    if (!directory) throw new Error('Native task working-directory service is unavailable.');
    // Only initialize an untouched project directory. Restored tasks may have
    // deliberately changed their effective directory; never reset that state.
    const initialized = record.agent.session.snapshotEvents().some(event => event.type === 'working-directory/change');
    if (!initialized && path.resolve(directory.get(record.agent.session)) === path.resolve(project)) await directory.set(record.agent, input.cwd);
  }
}

/** Title ownership is public only after Agent.create/resume has entered its
 * Session into the store. Calling rename during setup is too early. */
export function nameBotSession(ctx, record, input) {
  if (input.sessionTitle !== undefined) {
    if (typeof input.sessionTitle !== 'string' || !input.sessionTitle.trim() || input.sessionTitle.length > 100) throw new Error('Invalid companion task title.');
    const titles = ctx.get('sessionTitle');
    if (!titles) throw new Error('Native Session title service is unavailable.');
    const existing = titles.get(record.agent.session);
    if (existing?.source?.kind !== 'user') titles.rename(record.agent.session, input.sessionTitle.trim());
  }
}

export async function attachBotWorkspace(ctx, record, input) {
  if (input.workspaceTitle === undefined) return;
  const project = botProjectDirectory(input), headerCwd = record.agent.session.header.cwd;
  // Native DSH rejects moving immutable legacy headers. Keep their original
  // execution record, correct its labels, and never rewrite/replay its log.
  const legacy = path.resolve(headerCwd) !== path.resolve(project);
  if (legacy && path.resolve(headerCwd) !== path.resolve(input.cwd)) throw new Error('Companion Session project ownership differs.');
  nameBotSession(ctx, record, input);
  const title = (input.workspaceParent?.title ?? input.workspaceTitle).trim();
  const workspace = await ctx.workspaceRegistry.create(legacy ? input.cwd : project, title);
  if (workspace.title !== title) await workspace.setTitle(title);
  await ctx.sessions.flush(record.agent.session);
  await workspace.attachSession(record.id);
  return workspace;
}
