import path from 'node:path';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import type { BrowserPageImage } from '../../shared/browser-page-image';
import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { fullPageImage } from './full-page-image';

/** Private temporary files and small preview bands, addressed by opaque job ID. */
export class BrowserPageImageJob {
  state?: BrowserPageImage;
  private directory?: string;
  private controller?: AbortController;
  private running?: Promise<void>;
  private starting = false;
  private saving?: Promise<void>;
  constructor(private readonly root: string, private readonly changed: () => void) {}
  async start(tabId: string, title: string, contents: WebContents, isCurrent: () => boolean): Promise<void> {
    if (this.starting || this.running || this.state?.phase === 'saving') throw Error('正在生成或保存长图，请先完成或取消当前操作。');
    this.starting = true;
    try { await this.clear(); } catch (error) { this.starting = false; throw error; }
    const id = randomUUID(), controller = new AbortController(); this.controller = controller;
    this.state = { id, tabId, title: title.slice(0, 500), phase: 'preparing', completed: 0, total: 0 }; this.changed();
    this.running = (async () => {
      try {
        await mkdir(this.root, { recursive: true }); this.directory = await mkdtemp(path.join(this.root, 'capture-'));
        const result = await fullPageImage(contents, { directory: this.directory, signal: controller.signal, isCurrent,
          progress: (phase, completed, total, size) => { this.state = { ...this.state!, ...size, phase, completed, total }; this.changed(); } });
        this.state = { ...this.state!, ...result, phase: 'preview' };
      } catch (error) {
        this.state = { ...this.state!, phase: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? undefined : (error instanceof Error ? error.message : String(error)).slice(0, 1000) };
        await this.removeFiles().catch(() => undefined);
      } finally { this.changed(); }
    })().finally(() => { this.running = undefined; });
    this.starting = false;
  }
  private require(id: string) { if (this.state?.id !== id) throw Error('长图预览已过期，请重新生成。'); return this.state; }
  cancel(id: string): void { this.require(id); this.controller?.abort(); }
  async tile(id: string, index: number): Promise<string> {
    const state = this.require(id), directory = this.directory;
    if (!['preview', 'saving', 'saved'].includes(state.phase) || !directory || !Number.isSafeInteger(index) || index < 0 || index >= (state.bands ?? 0)) throw Error('长图预览分块不可用。');
    const bytes = await readFile(path.join(directory, `preview-${index}.jpg`)); this.require(id);
    return 'data:image/jpeg;base64,' + bytes.toString('base64');
  }
  async save(id: string, choose: (title: string) => Promise<string | undefined>): Promise<void> {
    const state = this.require(id); if (!this.directory || !['preview', 'saved'].includes(state.phase)) throw Error('请等待长图生成完成后再保存。');
    const source = path.join(this.directory, 'page.png'); this.state = { ...state, phase: 'saving', error: undefined }; this.changed();
    this.saving = this.persist(id, state, source, choose); await this.saving; this.saving = undefined;
  }
  private async persist(id: string, state: BrowserPageImage, source: string, choose: (title: string) => Promise<string | undefined>) {
    let temporary: string | undefined;
    try {
      const target = await choose(state.title); this.require(id);
      if (!target) { this.state = { ...state, phase: 'preview' }; return; }
      temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.' + randomUUID() + '.tmp');
      await copyFile(source, temporary); await rename(temporary, target); temporary = undefined;
      this.state = { ...state, phase: 'saved', savedPath: target, error: undefined };
    } catch (error) { this.state = { ...state, phase: 'preview', error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }; }
    finally { if (temporary) await rm(temporary, { force: true }).catch(() => undefined); this.changed(); }
  }
  private async removeFiles() {
    const directory = this.directory; if (!directory) return;
    const relative = path.relative(path.resolve(this.root), path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('capture-')) throw Error('长图临时目录不在预期范围内。');
    await rm(directory, { recursive: true, force: true }); this.directory = undefined;
  }
  async clear(): Promise<void> {
    if (this.state?.phase === 'saving') throw Error('长图正在保存，请稍候。');
    this.controller?.abort(); await this.running; await this.removeFiles(); this.state = undefined; this.controller = undefined; this.changed();
  }
  async shutdown(): Promise<void> { this.controller?.abort(); await this.saving; await this.clear(); }
}
