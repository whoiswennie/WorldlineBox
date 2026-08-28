import { app, BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'

export type RuntimeStage = 'starting' | 'serving' | 'ready' | 'failed' | 'stopping'

export interface RuntimeStageSnapshot {
  stage: RuntimeStage
  detail?: string
}

export class DesktopRuntimeBridge extends Service {
  // Cordis exposes services through a Proxy. Native `#private` fields reject
  // that receiver during method calls, so service state must use ordinary
  // class properties (TypeScript `private` still keeps the API encapsulated).
  private currentSnapshot: RuntimeStageSnapshot = { stage: 'starting' }
  private readonly listeners = new Set<(snapshot: RuntimeStageSnapshot) => void>()

  constructor(ctx: Context) {
    super(ctx, 'desktopRuntimeBridge')
  }

  get snapshot(): RuntimeStageSnapshot { return this.currentSnapshot }

  publish(snapshot: RuntimeStageSnapshot): void {
    this.currentSnapshot = snapshot
    for (const listener of [...this.listeners]) listener(snapshot)
  }

  subscribe(listener: (snapshot: RuntimeStageSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.currentSnapshot)
    return () => { this.listeners.delete(listener) }
  }
}

export class DesktopAssets extends Service {
  constructor(ctx: Context) {
    super(ctx, 'desktopAssets')
  }

  iconIco(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'app-icon.ico')
      : join(import.meta.dirname, '..', '..', '..', 'build', 'icon.ico')
  }

  logoPng(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'app-logo.png')
      : join(import.meta.dirname, '..', '..', '..', 'build', 'startup-logo.png')
  }

}

export class DesktopWindows extends Service {
  private readonly windows = new Set<BrowserWindow>()

  constructor(ctx: Context) {
    super(ctx, 'desktopWindows')
    ctx.effect(() => () => { this.closeAll() }, 'worldline-desktop: close tracked windows')
  }

  create(options: BrowserWindowConstructorOptions): BrowserWindow {
    const window = new BrowserWindow(options)
    this.windows.add(window)
    window.once('closed', () => { this.windows.delete(window) })
    return window
  }

  closeAll(): void {
    for (const window of [...this.windows]) {
      if (!window.isDestroyed()) window.close()
    }
    this.windows.clear()
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    desktopAssets: DesktopAssets
    desktopWindows: DesktopWindows
    desktopRuntimeBridge: DesktopRuntimeBridge
  }
}
