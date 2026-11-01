import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface CompanionArtifactLockFootprint {
  exclusiveOwner?: boolean;
  writeArtifacts?: readonly string[];
  readArtifacts?: readonly string[];
  writePaths?: readonly string[];
  readPaths?: readonly string[];
}

type Resources = { exclusiveOwner: boolean; writes: Set<string>; reads: Set<string>; writePaths: string[]; readPaths: string[] };
type Waiter = { resources: Resources; resolve(release: () => void): void };
type RootLocks = { active: Set<Waiter>; pending: Waiter[] };
type OperationTicket = { key: string; active: boolean };
type ResourceTicket = { root: string; resources: Resources; active: boolean };
const held = new AsyncLocalStorage<{ operations: OperationTicket[]; resources: ResourceTicket[] }>();
const operations = new Map<string, Promise<unknown>>();
const roots = new Map<string, RootLocks>();
const rootKey = (root: string) => path.resolve(root).replaceAll('\\', '/').toLocaleLowerCase('en-US');
const pathKey = (relative: string) => relative.toLocaleLowerCase('en-US');
const intersects = (left: Set<string>, right: Set<string>) => [...left].some(key => right.has(key));
const relatedPath = (left: string, right: string) => left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
const pathsIntersect = (left: readonly string[], right: readonly string[]) => left.some(a => right.some(b => relatedPath(a, b)));

/** A validation callback cannot wait for a conflicting lock held by its own
 * async ancestor. Fail closed; never bypass a held lock or silently proceed. */
export class CompanionArtifactLockConflictError extends Error {
  readonly code = 'CONFLICT';
  constructor() { super('发布校验不能等待当前操作自己持有的对象锁；本次未继续提交，请在原操作结束后重新核验。'); this.name = 'CompanionArtifactLockConflictError'; }
}

function conflicts(a: Resources, b: Resources): boolean {
  return a.exclusiveOwner || b.exclusiveOwner
    || intersects(a.writes, b.writes) || intersects(a.writes, b.reads) || intersects(a.reads, b.writes)
    || pathsIntersect(a.writePaths, b.writePaths) || pathsIntersect(a.writePaths, b.readPaths) || pathsIntersect(a.readPaths, b.writePaths);
}

function drain(key: string, state: RootLocks): void {
  // Preserve arrival order only between conflicting requests. A slow source
  // publication must not hold an unrelated context receipt behind it.
  const blocked: Waiter[] = [];
  for (const waiter of state.pending) {
    if ([...state.active, ...blocked].some(other => conflicts(waiter.resources, other.resources))) { blocked.push(waiter); continue; }
    state.active.add(waiter);
    waiter.resolve(() => {
      state.active.delete(waiter); drain(key, state);
      if (!state.active.size && !state.pending.length && roots.get(key) === state) roots.delete(key);
    });
  }
  state.pending = blocked;
}

/** Operation identity is acquired before any file resource. It is deliberately
 * separate from owner-exclusive creation, so creation never waits on itself. */
export function withCompanionArtifactOperation<T>(root: string, operationId: string, operation: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([rootKey(root), operationId]);
  const inherited = held.getStore();
  if (inherited?.operations.some(ticket => ticket.active && ticket.key === key)) return Promise.reject(new CompanionArtifactLockConflictError());
  const pending = (operations.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const ticket: OperationTicket = { key, active: true };
    try { return await held.run({ operations: [...inherited?.operations ?? [], ticket], resources: inherited?.resources ?? [] }, operation); }
    finally { ticket.active = false; }
  });
  operations.set(key, pending);
  void pending.finally(() => { if (operations.get(key) === pending) operations.delete(key); }).catch(() => undefined);
  return pending;
}

/** One atomic read/write footprint, never a sequence of partially held locks.
 * SQLite reservations, live permissions, leases and CAS remain authoritative. */
export async function withCompanionArtifactResources<T>(root: string, footprint: CompanionArtifactLockFootprint, operation: () => Promise<T>): Promise<T> {
  const key = rootKey(root), inherited = held.getStore();
  const writes = new Set(footprint.writeArtifacts ?? []), reads = new Set(footprint.readArtifacts ?? []);
  for (const id of writes) reads.delete(id);
  const writePaths = [...new Set((footprint.writePaths ?? []).map(pathKey))];
  const readPaths = [...new Set((footprint.readPaths ?? []).map(pathKey))].filter(relative => !writePaths.includes(relative));
  const resources: Resources = { exclusiveOwner: !!footprint.exclusiveOwner, writes, reads, writePaths, readPaths };
  if (inherited?.resources.some(ticket => ticket.active && ticket.root === key && conflicts(resources, ticket.resources))) throw new CompanionArtifactLockConflictError();
  const state = roots.get(key) ?? { active: new Set<Waiter>(), pending: [] }; roots.set(key, state);
  const release = await new Promise<() => void>(resolve => { state.pending.push({ resources, resolve }); drain(key, state); });
  const ticket: ResourceTicket = { root: key, resources, active: true };
  try { return await held.run({ operations: inherited?.operations ?? [], resources: [...inherited?.resources ?? [], ticket] }, operation); }
  finally { ticket.active = false; release(); }
}
