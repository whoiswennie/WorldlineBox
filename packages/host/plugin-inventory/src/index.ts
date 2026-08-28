/** Guarded local projection and management of Cordis plugins and Skills. */

import { rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, dirname, parse } from 'node:path'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { LocalExtensionState } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-skill'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventoryListRequest,
  PluginInventorySnapshot,
  PluginInventoryMutationRequest,
  SkillInventoryMutationRequest,
  ToolchainStatus,
  ToolchainStatusSnapshot,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

type ToolchainProbe = (command: string, args: readonly string[]) => Promise<string | undefined>

function commandVersion(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      resolve(error === null ? `${stdout}\n${stderr}` : undefined)
    })
  })
}

function status(output: string | undefined): ToolchainStatus {
  if (output === undefined) return { ready: false }
  const version = /\bv?(\d+(?:\.\d+)+(?:[-+.][0-9A-Za-z.-]+)?)/.exec(output)?.[1]
  return version === undefined ? { ready: true } : { ready: true, version }
}

async function firstVersion(
  candidates: readonly (readonly [string, readonly string[]])[],
  probe: ToolchainProbe,
): Promise<ToolchainStatus> {
  for (const [command, args] of candidates) {
    const output = await probe(command, args)
    if (output !== undefined) return status(output)
  }
  return { ready: false }
}

/**
 * Detect the local command-line environment without exposing paths or inherited variables.
 * @param probe - injectable bounded command probe.
 * @param nodeVersion - embedded runtime version used when no standalone Node command exists.
 * @returns one immutable point-in-time toolchain snapshot.
 */
export async function detectToolchains(
  probe: ToolchainProbe = commandVersion,
  nodeVersion: string = process.version,
): Promise<ToolchainStatusSnapshot> {
  const [python, git, nodeCommand] = await Promise.all([
    firstVersion(process.platform === 'win32'
      ? [['py', ['-3', '--version']], ['python', ['--version']]]
      : [['python3', ['--version']], ['python', ['--version']]], probe),
    firstVersion([['git', ['--version']]], probe),
    firstVersion([['node', ['--version']]], probe),
  ])
  return {
    python,
    git,
    // The packaged desktop Host itself runs on Node, so its embedded runtime
    // remains authoritative when no standalone `node` executable is on PATH.
    node: nodeCommand.ready ? nodeCommand : status(nodeVersion),
    detectedAt: Date.now(),
  }
}

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader', 'clientModules', 'skills', 'agentPresets']
  private readonly toolchainSnapshot: Promise<ToolchainStatusSnapshot>

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
    this.toolchainSnapshot = detectToolchains()
    for (const name of ctx.get('profileRuntime')?.localExtensions().disabledSkills ?? []) {
      ctx.skills.setEnabled(name, false)
    }
    ctx.on('skills/change', () => { ctx.emit('plugin-inventory/change') })
    ctx.on('loader/entry-init', () => { ctx.emit('plugin-inventory/change') })
    ctx.on('loader/partial-dispose', () => { ctx.emit('plugin-inventory/change') })
  }

  private protectedPlugin(entryId: string, moduleName: string): boolean {
    return entryId === 'include'
      || entryId === 'plugin-inventory'
      || moduleName.startsWith('@deepseek-ai/dsh-')
      || moduleName.startsWith('@deepseek-ai/')
      || moduleName.startsWith('cordis:')
  }

  private entry(entryId: string) {
    const matches = [...this.ctx.loader.entries()].filter(entry => entry.id === entryId)
    if (matches.length !== 1) throw new Error(matches.length === 0 ? '插件不存在或已经删除' : '插件标识不唯一，无法安全修改')
    const [entry] = matches
    if (entry === undefined) throw new Error('插件索引状态无效')
    if (this.protectedPlugin(entryId, entry.options.name)) throw new Error('核心插件受保护，不能修改')
    return entry
  }

  private async updateState(change: (state: LocalExtensionState) => LocalExtensionState): Promise<void> {
    const runtime = this.ctx.get('profileRuntime')
    if (runtime === undefined) throw new Error('当前运行方式没有本地 Profile 管理能力')
    await runtime.updateLocalExtensions(change(runtime.localExtensions()))
  }

  /** Resolve the same layered Skill catalog a new session on the default preset receives. */
  private async skillView(cwd: string | undefined) {
    return {
      includeDisabled: true,
      cwd,
      scope: await this.ctx.agentPresets.standingKeyFor(),
    } as const
  }

  private listRequest(cwd: string | undefined): PluginInventoryListRequest {
    return cwd === undefined ? {} : { cwd }
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   * @param request - optional workspace cwd for project-skill discovery.
   * @returns Current non-group Loader entries in Loader order.
   */
  @Remote('list')
  async list(request: PluginInventoryListRequest): Promise<PluginInventorySnapshot> {
    const entries: PluginInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
        protected: this.protectedPlugin(entry.options.id, entry.options.name),
      })
    }
    const skillView = await this.skillView(request.cwd)
    const skills = await this.ctx.skills.list(skillView)
    return {
      entries,
      clientModules: this.ctx.clientModules.graph().entries.map(entry => entry.id),
      skillIds: skills.filter(skill => this.ctx.skills.isEnabled(skill.name)).map(skill => skill.name),
      skills: skills.map(skill => ({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        provider: skill.provider,
        enabled: this.ctx.skills.isEnabled(skill.name),
        modelInvocable: skill.invocation.modelInvocable,
        userInvocable: skill.invocation.userInvocable,
        ...(skill.resourceBase?.kind === 'directory'
          ? { directory: skill.resourceBase.path }
          : {}),
        canDelete: skill.source === 'project-worldline'
          || skill.source === 'project-agents'
          || skill.source === 'user-worldline'
          || skill.source === 'user-agents'
          || skill.source === 'custom',
      })),
    }
  }

  /**
   * Return the immutable toolchain snapshot captured while this Host service started.
   * @returns the startup-time toolchain status.
   */
  @Remote('toolchains')
  async toolchains(): Promise<ToolchainStatusSnapshot> {
    return await this.toolchainSnapshot
  }

  /**
   * Persist and apply enablement for one non-core Loader row.
   * @param request - target entry, desired state, and optional skill-discovery cwd.
   * @returns the refreshed plugin and skill inventory.
   */
  @Remote('setPluginEnabled')
  async setPluginEnabled(request: PluginInventoryMutationRequest): Promise<PluginInventorySnapshot> {
    this.entry(request.entryId)
    if (typeof request.enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值')
    await this.updateState(state => ({
      ...state,
      disabledPlugins: request.enabled
        ? state.disabledPlugins.filter(id => id !== request.entryId)
        : [...new Set([...state.disabledPlugins, request.entryId])],
      removedPlugins: state.removedPlugins.filter(id => id !== request.entryId),
    }))
    this.ctx.emit('plugin-inventory/change')
    return await this.list(this.listRequest(request.cwd))
  }

  /**
   * Remove one non-core Loader row from the local Profile composition.
   * @param request - target entry and optional skill-discovery cwd.
   * @returns the refreshed plugin and skill inventory.
   */
  @Remote('deletePlugin')
  async deletePlugin(request: PluginInventoryMutationRequest): Promise<PluginInventorySnapshot> {
    this.entry(request.entryId)
    await this.updateState(state => ({
      ...state,
      disabledPlugins: state.disabledPlugins.filter(id => id !== request.entryId),
      removedPlugins: [...new Set([...state.removedPlugins, request.entryId])],
    }))
    this.ctx.emit('plugin-inventory/change')
    return await this.list(this.listRequest(request.cwd))
  }

  /**
   * Persist and apply one skill's local discovery visibility.
   * @param request - target skill, desired state, and optional discovery cwd.
   * @returns the refreshed plugin and skill inventory.
   */
  @Remote('setSkillEnabled')
  async setSkillEnabled(request: SkillInventoryMutationRequest): Promise<PluginInventorySnapshot> {
    if (typeof request.enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值')
    const skillView = await this.skillView(request.cwd)
    const exists = (await this.ctx.skills.list(skillView))
      .some(skill => skill.name === request.name)
    if (!exists) throw new Error('技能不存在或已经删除')
    await this.updateState(state => ({
      ...state,
      disabledSkills: request.enabled
        ? state.disabledSkills.filter(name => name !== request.name)
        : [...new Set([...state.disabledSkills, request.name])],
    }))
    this.ctx.skills.setEnabled(request.name, request.enabled)
    return await this.list(this.listRequest(request.cwd))
  }

  /**
   * Permanently remove one filesystem-backed non-bundled skill.
   * @param request - target skill and optional discovery cwd.
   * @returns the refreshed plugin and skill inventory.
   */
  @Remote('deleteSkill')
  async deleteSkill(request: SkillInventoryMutationRequest): Promise<PluginInventorySnapshot> {
    const skillView = await this.skillView(request.cwd)
    const summaries = await this.ctx.skills.list(skillView)
    const summary = summaries.find(skill => skill.name === request.name)
    const canDelete = summary?.source === 'project-worldline'
      || summary?.source === 'project-agents'
      || summary?.source === 'user-worldline'
      || summary?.source === 'user-agents'
      || summary?.source === 'custom'
    if (!canDelete) throw new Error('内置或运行时技能受保护，不能删除')
    const definition = await this.ctx.skills.get(request.name, skillView)
    if (definition?.path === undefined) throw new Error('技能没有可安全删除的本地文件')
    const target = basename(definition.path).toLocaleLowerCase() === 'skill.md'
      ? dirname(definition.path)
      : definition.path
    if (dirname(target) === target || target === parse(target).root) throw new Error('拒绝删除文件系统根目录')
    await rm(target, { recursive: true, force: false })
    await this.updateState(state => ({
      ...state,
      disabledSkills: state.disabledSkills.filter(name => name !== request.name),
    }))
    this.ctx.skills.setEnabled(request.name, true)
    this.ctx.skills.refresh()
    return await this.list(this.listRequest(request.cwd))
  }
}

export default PluginInventoryGateway
