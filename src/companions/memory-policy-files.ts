import { createHash } from 'node:crypto';
import { lstatSync, openSync, closeSync, readSync, fstatSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { CompanionConnection } from './store';
import { COMPANION_MEMORY_POLICY_FILE, companionMemoryPolicyFileSchema, initialCompanionMemoryPolicy, type CompanionMemoryPolicy } from '../shared/companion-memory-policy';

export interface CompanionMemoryPolicyReceipt { policy: CompanionMemoryPolicy; revision: string; canonical: boolean }
export class CompanionMemoryPolicyUnavailableError extends Error {
  readonly code = 'MEMORY_POLICY_UNAVAILABLE';
  constructor(readonly companionId: string, cause?: unknown) {
    super('伙伴记忆策略文件缺失、损坏或目录不安全；维护与编码等待文件恢复，不使用旧值或初始默认。', { cause });
    this.name = 'CompanionMemoryPolicyUnavailableError';
  }
}
const validOwner = (owner: string) => /^[a-zA-Z0-9_-]{1,100}$/u.test(owner);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const stamp = (stat: Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
function safeDirectory(directory: string, allowMissing = false): string {
  if (!path.isAbsolute(directory)) throw new Error('Policy root must be absolute.');
  let current = path.parse(directory).root;
  const parts = path.relative(current, directory).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const next = path.join(current, parts[index]!); let stat: Stats;
    try { stat = lstatSync(next); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return path.join(realpathSync(current), ...parts.slice(index)); throw error; }
    current = next;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked policy directory.');
  }
  return realpathSync(directory);
}

/** A bound worker reads only the host-selected library's exact owner file.
 * Every use rechecks path and stat; only unchanged authorized bytes reuse the
 * parsed policy. Bad files are never cached and no DB role copy is consulted. */
export class CompanionMemoryPolicyFiles {
  private readonly root: string;
  private readonly cache = new Map<string, { stamp: string; receipt: CompanionMemoryPolicyReceipt }>();
  constructor(root: string) { if (!path.isAbsolute(root)) throw new Error('Policy root must be absolute.'); this.root = safeDirectory(path.resolve(root), true); }
  read(owner: string): CompanionMemoryPolicyReceipt {
    try {
      if (!validOwner(owner) || safeDirectory(this.root) !== this.root) throw new Error('Owner policy identity changed.');
      const directory = path.join(this.root, owner);
      if (safeDirectory(directory) !== directory) throw new Error('Owner policy root changed.');
      const file = path.join(directory, COMPANION_MEMORY_POLICY_FILE), before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16 * 1024) throw new Error('Invalid policy file.');
      const currentStamp = stamp(before), cached = this.cache.get(owner);
      if (cached?.stamp === currentStamp) return cached.receipt;
      const descriptor = openSync(file, 'r'); let text: string;
      try {
        if (stamp(fstatSync(descriptor)) !== currentStamp) throw new Error('Policy changed before open.');
        const buffer = Buffer.alloc(before.size + 1); let length = 0;
        while (length < buffer.length) { const count = readSync(descriptor, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
        if (length !== before.size || stamp(fstatSync(descriptor)) !== currentStamp || stamp(lstatSync(file)) !== currentStamp)
          throw new Error('Policy changed during read.');
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
      } finally { closeSync(descriptor); }
      const parsed = companionMemoryPolicyFileSchema.parse(JSON.parse(text.replace(/^\uFEFF/u, '')));
      if (parsed.companionId !== owner || safeDirectory(directory) !== directory) throw new Error('Policy belongs to another owner.');
      const receipt: CompanionMemoryPolicyReceipt = { policy: parsed.policy, revision: hash(text), canonical: true };
      this.cache.set(owner, { stamp: currentStamp, receipt });
      while (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value!);
      return receipt;
    } catch (cause) { this.cache.delete(owner); throw new CompanionMemoryPolicyUnavailableError(owner, cause); }
  }
}
const bindings = new WeakMap<CompanionConnection, CompanionMemoryPolicyFiles>();
/** Host-only bootstrap command; this is not part of the model world tool. */
export function bindCompanionMemoryPolicyRoot(db: CompanionConnection, root: string): void { bindings.set(db, new CompanionMemoryPolicyFiles(root)); }
export function resolveCompanionMemoryPolicy(db: CompanionConnection, owner: string): CompanionMemoryPolicyReceipt {
  const bound = bindings.get(db);
  if (bound) return bound.read(owner);
  const policy = initialCompanionMemoryPolicy();
  return { policy, revision: hash(JSON.stringify(policy)), canonical: false };
}
