import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../../..')
const live: ChildProcess[] = []
const homes: string[] = []
const WEB_START_TIMEOUT_MS = 60_000

function waitForWeb(child: ChildProcess): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let output = ''
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.stdout?.off('data', inspect)
      child.stderr?.off('data', inspect)
      child.off('exit', exited)
      callback()
    }
    const inspect = (chunk: Buffer): void => {
      output += chunk.toString()
      const url = /worldline web: (http:\/\/[^\s]+)/.exec(output)?.[1]
      if (url !== undefined) {
        finish(() => { resolveReady(url) })
      }
    }
    const exited = (code: number | null): void => {
      finish(() => { reject(new Error(`web profile exited with ${String(code)}:\n${output}`)) })
    }
    const timeout = setTimeout(() => {
      finish(() => { reject(new Error(`web profile did not start:\n${output}`)) })
    }, WEB_START_TIMEOUT_MS)
    child.stdout?.on('data', inspect)
    child.stderr?.on('data', inspect)
    child.once('exit', exited)
  })
}

async function launchBuiltWeb(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'worldline-web-profile-'))
  homes.push(home)
  const child = spawn(process.execPath, [join(repo, 'apps/cli/lib/bin.js'), 'web', '--port', '0'], {
    cwd: home,
    env: {
      ...process.env,
      WORLDLINE_HOME: join(home, '.worldline'),
      WORLDLINE_AGENTS_HOME: join(home, '.agents'),
      DEEPSEEK_API_KEY: 'keyless-profile-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  live.push(child)
  return waitForWeb(child)
}

afterEach(async () => {
  for (const child of live.splice(0)) {
    if (child.exitCode === null) {
      const exited = new Promise<void>(resolveExit => child.once('exit', () => { resolveExit() }))
      child.kill()
      await exited
    }
  }
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
  }
})

describe('built Web profile', () => {
  it('keeps the Worldline shell and account boundary without optional experience features', () => {
    const base = readFileSync(join(repo, 'packages/bundle/base/cordis.patch.yml'), 'utf8')
    const web = readFileSync(join(repo, 'packages/bundle/web-app/cordis.patch.yml'), 'utf8')
    const composed = `${base}\n${web}`

    for (const retained of ['@deepseek-ai/dsh-local-auth', '@deepseek-ai/dsh-client-ui-auth',
      '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-worldline-chrome',
      '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-plugin-center',
      '@deepseek-ai/dsh-client-ui-netease-music',
      '@deepseek-ai/dsh-client-ui-settings-general', '@deepseek-ai/dsh-client-ui-settings-plugins',
      '@deepseek-ai/dsh-host-plugin-inventory', '@deepseek-ai/dsh-host-workspace-tree-local',
      '@deepseek-ai/dsh-skill-agent-vault']) {
      expect(composed).toContain(retained)
    }
    for (const removed of ['memory-hub', 'tool-memory', 'ui-memory', 'desktop-experience',
      'ui-personalization', 'startup-splash', 'desktop-pet', 'live2d-companion',
      'workbench-host', 'ui-workbench', 'ui-workbench-browser',
      'ui-workbench-terminal', 'ui-workbench-editor', 'ui-plugin-market',
      'plugin-market-npm', 'ui-settings-plugin-inventory']) {
      expect(composed).not.toContain(removed)
    }
  })

  it('keeps concrete workspace providers and bundled Skill policy in the Bundle', () => {
    const web = readFileSync(join(repo, 'packages/bundle/web-app/cordis.patch.yml'), 'utf8')
    const apiProxy = readFileSync(join(repo, 'packages/host/apiproxy/src/index.ts'), 'utf8')
    const apiManifest = JSON.parse(readFileSync(
      join(repo, 'packages/host/apiproxy/package.json'),
      'utf8',
    )) as { dependencies?: Record<string, string> }

    expect(web).toMatch(/id: workspace-tree-local[\s\S]*?name: '@deepseek-ai\/dsh-host-workspace-tree-local'/u)
    expect(`${readFileSync(join(repo, 'packages/bundle/base/cordis.patch.yml'), 'utf8')}\n${web}`)
      .toContain("name: '@deepseek-ai/dsh-skill-agent-vault'")
    expect(apiProxy).not.toContain('LocalWorkspaceTree')
    expect(apiManifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-host-workspace-tree-local')
  })

  it('ships five behaviorally distinct agent-plane compositions', () => {
    const presetRoot = join(repo, 'apps/cli/config/agent-presets')
    const readPreset = (id: string, file: 'preset.yml' | 'agent.cordis.yml'): string =>
      readFileSync(join(presetRoot, id, file), 'utf8')

    const expected = [
      ['standard', '标准模式', 'order: 1'],
      ['ptc', 'PTC 模式', 'order: 2'],
      ['minimal', '极简模式', 'order: 3'],
      ['cordis', '创造模式', 'order: 4'],
      ['virtual-companion', '虚拟伙伴', 'order: 5'],
    ] as const
    expect(readdirSync(presetRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()).toEqual(expected.map(([id]) => id).sort())
    for (const [id, name, order] of expected) {
      const metadata = readPreset(id, 'preset.yml')
      expect(metadata).toContain(`name: ${name}`)
      expect(metadata).toContain(order)
    }

    const standard = readPreset('standard', 'agent.cordis.yml')
    expect(standard).toContain("name: '@deepseek-ai/dsh-persona'")
    expect(standard).toContain("name: '@deepseek-ai/dsh-tool-ask-user'")
    expect(standard).toContain('backgroundMode: continuable')

    const ptc = readPreset('ptc', 'agent.cordis.yml')
    expect(ptc).toContain("name: '@deepseek-ai/dsh-agent-tool-presentation'")
    expect(ptc).toContain('mode: ptc')

    const minimal = readPreset('minimal', 'agent.cordis.yml')
    expect(minimal).toContain('complete: true')
    expect(minimal).toContain("name: '@deepseek-ai/dsh-tool-bash-persistent'")
    expect(minimal).toContain("name: '@deepseek-ai/dsh-tool-str-replace-editor'")
    expect(minimal).not.toContain('@deepseek-ai/dsh-compaction-basic')

    const cordis = readPreset('cordis', 'agent.cordis.yml')
    expect(cordis).toContain("name: '@deepseek-ai/dsh-tool-cordis'")
    expect(cordis).toContain('editing-cordis-compositions')

    const companion = readPreset('virtual-companion', 'agent.cordis.yml')
    expect(companion).toContain('主调度 Agent')
    expect(companion).toContain('dispatch_companion')
    expect(companion).toContain('运行时按房间严格串行')
    expect(companion).toContain("name: '@deepseek-ai/dsh-account-profile-context'")
    expect(companion).toContain("name: '@deepseek-ai/dsh-tool-web'")
    expect(companion).toContain('@deepseek-ai/dsh-tool-fs')
    expect(companion).toContain('@deepseek-ai/dsh-tool-bash')
    expect(companion).toContain('@deepseek-ai/dsh-compaction-basic')
  })

  it('serves the production client without an orchestration runtime dependency', async () => {
    const url = await launchBuiltWeb()
    const html = await (await fetch(url)).text()
    expect(html).toContain('__WORLDLINE_BOOT__')
    expect(html).toContain('id="root"')
  }, WEB_START_TIMEOUT_MS + 15_000)

  it('mounts every shipped agent preset through the production session boundary', async () => {
    const url = await launchBuiltWeb()
    for (const agentPreset of ['standard', 'ptc', 'minimal', 'cordis', 'virtual-companion']) {
      const sessionId = `preset-${agentPreset}`
      const response = await fetch(`${url}/api/session.create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: sessionId,
          method: 'session.create',
          payload: { sessionId, cwd: repo, agentPreset },
        }),
      })
      expect(response.ok).toBe(true)
      const body = await response.json() as {
        result?: { ok?: boolean; value?: { sessionId?: string; agentPreset?: string } }
      }
      expect(body.result).toEqual({ ok: true, value: { sessionId, agentPreset } })
    }
  }, WEB_START_TIMEOUT_MS + 15_000)
})
