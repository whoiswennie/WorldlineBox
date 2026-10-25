import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CompanionMemory } from '../../shared/companions';
import type { VcpMemoryTimelineArtifacts } from '../vcp-memory/contracts';

type View = { scopeId: string; identity: string; profileKey: string; dirty: boolean; notes: Record<string, string>; projectionSignature?: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fingerprints(notes: readonly CompanionMemory[]) {
  return Object.fromEntries(notes.map(note => [note.id, hash(JSON.stringify([note.version, note.content, note.tags, note.occurredAt,
    note.diaryName, note.metadata, note.sourceConversationId, note.sources, note.captureMethod]))]));
}

/** Only monotonic additions reuse a graph. Retraction, revision or an interrupted write rebuilds it. */
export class CompanionMemoryViewCache {
  private readonly memory = new Map<string, View>();
  private readonly artifacts = new Map<string, VcpMemoryTimelineArtifacts>();
  constructor(private readonly directory?: string) {}
  private file(key: string) { return path.join(this.directory!, `${hash(key)}.json`); }
  private async save(key: string, view: View): Promise<void> {
    this.memory.set(key, view);
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true });
    const file = this.file(key), temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(view), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  }
  async prepare(identity: string, profileKey: string, notes: readonly CompanionMemory[], projectionSignature?: string) {
    const key = `${identity}\n${profileKey}`;
    let previous = this.memory.get(key);
    if (!previous && this.directory) {
      try {
        const parsed: unknown = JSON.parse(await readFile(this.file(key), 'utf8'));
        if (parsed && typeof parsed === 'object' && 'scopeId' in parsed && typeof parsed.scopeId === 'string'
          && /^view_[a-f0-9]{32}$/u.test(parsed.scopeId) && 'profileKey' in parsed && parsed.profileKey === profileKey
          && 'identity' in parsed && parsed.identity === identity
          && 'dirty' in parsed && typeof parsed.dirty === 'boolean' && 'notes' in parsed && parsed.notes
          && typeof parsed.notes === 'object' && !Array.isArray(parsed.notes)
          && Object.values(parsed.notes).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))) previous = parsed as View;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    const target = fingerprints(notes);
    const reusable = previous && !previous.dirty && previous.profileKey === profileKey && previous.projectionSignature === projectionSignature
      && Object.entries(previous.notes).every(([id, fingerprint]) => target[id] === fingerprint);
    const unchanged = !!reusable && Object.keys(previous!.notes).length === notes.length;
    const scopeId = reusable && previous ? previous.scopeId : `view_${randomUUID().replaceAll('-', '')}`;
    const view: View = { scopeId, identity, profileKey, dirty: true, notes: target, projectionSignature };
    if (!unchanged) await this.save(key, view);
    return { scopeId, unchanged, replacedScopeId: previous && previous.scopeId !== scopeId ? previous.scopeId : undefined,
      commit: async () => { if (!unchanged) await this.save(key, { ...view, dirty: false }); } };
  }
  async loadArtifacts(identity: string, profileKey: string): Promise<VcpMemoryTimelineArtifacts | undefined> {
    const key = `${identity}\n${profileKey}`;
    if (this.artifacts.has(key)) return structuredClone(this.artifacts.get(key));
    if (!this.directory) return undefined;
    try {
      const stored = JSON.parse(await readFile(`${this.file(key)}.timeline`, 'utf8'));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
      const artifacts = ('artifacts' in stored ? stored.identity === identity && stored.profileKey === profileKey && stored.artifacts : stored) as VcpMemoryTimelineArtifacts;
      if (!artifacts) return undefined;
      if (artifacts.schema !== 'worldlinebox.vcp-timeline-artifacts' || typeof artifacts.sourceRevision !== 'string' || !Array.isArray(artifacts.agents)) return undefined;
      this.artifacts.set(key, artifacts); return structuredClone(artifacts);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined; throw error; }
  }
  async saveArtifacts(identity: string, profileKey: string, artifacts: VcpMemoryTimelineArtifacts): Promise<void> {
    this.artifacts.set(`${identity}\n${profileKey}`, structuredClone(artifacts));
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true });
    const file = `${this.file(`${identity}\n${profileKey}`)}.timeline`, temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ identity, profileKey, artifacts }), { encoding: 'utf8', mode: 0o600 }); await rename(temporary, file);
  }
  async clearArtifacts(identity: string, profileKey: string): Promise<void> {
    const key = `${identity}\n${profileKey}`;
    this.artifacts.delete(key);
    if (this.directory) await rm(`${this.file(key)}.timeline`, { force: true });
  }
  async invalidateOwner(owner: string): Promise<Array<{ scopeId: string; profileKey: string }>> {
    const invalidated = new Map<string, View>();
    for (const [key, view] of this.memory) if (view.identity.startsWith(`${owner}:`)) { invalidated.set(view.scopeId, view); this.memory.delete(key); }
    for (const key of this.artifacts.keys()) if (key.startsWith(`${owner}:`)) {
      this.artifacts.delete(key);
      if (this.directory) await rm(`${this.file(key)}.timeline`, { force: true });
    }
    if (this.directory) {
      let files: string[] = [];
      try { files = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/u.test(file))) {
        const target = path.join(this.directory, file);
        let view: View;
        try { view = JSON.parse(await readFile(target, 'utf8')) as View; } catch { continue; }
        if (typeof view.identity !== 'string' || !view.identity.startsWith(`${owner}:`)) continue;
        if (/^view_[a-f0-9]{32}$/u.test(view.scopeId)) invalidated.set(view.scopeId, view);
        await rm(target, { force: true }); await rm(`${target}.timeline`, { force: true });
      }
      for (const file of files.filter(file => /^[a-f0-9]{64}\.json\.timeline$/u.test(file))) {
        const target = path.join(this.directory, file);
        let artifactOwner: unknown;
        try { artifactOwner = JSON.parse(await readFile(target, 'utf8')).identity; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
        if (typeof artifactOwner === 'string' && artifactOwner.startsWith(`${owner}:`)) await rm(target, { force: true });
      }
    }
    return [...invalidated.values()].map(({ scopeId, profileKey }) => ({ scopeId, profileKey }));
  }
}
