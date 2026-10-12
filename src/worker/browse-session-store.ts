import { createHash, randomUUID } from 'node:crypto';

import type {
  FilterClause,
  SearchQuery,
  SearchScope,
  SortDefinition,
} from '../shared/asset-types';

/**
 * Worker-owned snapshot of an ordered browse scope. The snapshot contains
 * asset ids plus the small query context needed to enrich later pages with
 * search snippets; summaries, artifact descriptors and media bytes remain
 * outside the session store and are read for the requested page.
 *
 * `assetIds` may be only the first painted page. `declaredTotal` is the COUNT
 * at open; later pages re-query the stored definition until the ordered index
 * is completed (select-all / ids read).
 */
export interface BrowseSessionSnapshot {
  readonly sessionId: string;
  readonly libraryId: string;
  readonly libraryGeneration: number;
  readonly changeSequence: number;
  readonly queryFingerprint: string;
  /** Original query/sort are retained only to enrich later pages (snippets). */
  readonly query: SearchQuery | null;
  readonly filters: readonly FilterClause[] | null;
  readonly scope: SearchScope | null;
  readonly sort: SortDefinition | null;
  readonly showIgnored: boolean;
  /** Scope COUNT when the session opened. May exceed `assetIds.length`. */
  readonly declaredTotal: number;
  readonly assetIds: readonly string[];
  readonly createdAt: number;
}

export function browseSessionIndexComplete(session: BrowseSessionSnapshot): boolean {
  return session.assetIds.length >= session.declaredTotal;
}

/** True when this window can be sliced from the ids already snapshotted. */
export function browseSessionPageUsesSnapshot(
  session: BrowseSessionSnapshot,
  offset: number,
  limit: number,
): boolean {
  if (browseSessionIndexComplete(session)) return true;
  const start = Math.max(0, offset);
  const size = Math.max(0, limit);
  return start + size <= session.assetIds.length;
}

export type BrowseSessionLookup =
  | { status: 'ready'; session: BrowseSessionSnapshot }
  | { status: 'missing' }
  | { status: 'stale'; reason: 'library-generation' | 'change-sequence' };

/**
 * Bounded LRU for active browse snapshots. A snapshot is valid only for the
 * library generation and durable change sequence from which it was built.
 * Mutations therefore make a session stale instead of silently mixing pages
 * from two different query results.
 */
export class BrowseSessionStore {
  readonly #limit: number;
  readonly #sessions = new Map<string, BrowseSessionSnapshot>();

  constructor(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('BrowseSessionStore limit must be a positive integer.');
    }
    this.#limit = limit;
  }

  create(input: {
    libraryId: string;
    libraryGeneration: number;
    changeSequence: number;
    queryFingerprint: string;
    query?: SearchQuery | null;
    filters?: readonly FilterClause[] | null;
    scope?: SearchScope | null;
    sort?: SortDefinition | null;
    showIgnored?: boolean;
    declaredTotal?: number;
    assetIds: readonly string[];
    createdAt?: number;
  }): BrowseSessionSnapshot {
    const assetIds = [...input.assetIds];
    const session: BrowseSessionSnapshot = {
      sessionId: randomUUID(),
      libraryId: input.libraryId,
      libraryGeneration: input.libraryGeneration,
      changeSequence: input.changeSequence,
      queryFingerprint: input.queryFingerprint,
      query: input.query ?? null,
      filters: input.filters ? [...input.filters] : null,
      scope: input.scope ?? null,
      sort: input.sort ?? null,
      showIgnored: input.showIgnored === true,
      declaredTotal: input.declaredTotal ?? assetIds.length,
      assetIds,
      createdAt: input.createdAt ?? Date.now(),
    };
    this.#sessions.set(session.sessionId, session);
    this.#evictOldest();
    return session;
  }

  replaceAssetIds(
    libraryId: string,
    sessionId: string,
    assetIds: readonly string[],
  ): BrowseSessionSnapshot | null {
    const session = this.#sessions.get(sessionId);
    if (!session || session.libraryId !== libraryId) return null;
    const next: BrowseSessionSnapshot = {
      ...session,
      assetIds: [...assetIds],
      declaredTotal: assetIds.length,
    };
    this.#sessions.set(sessionId, next);
    return next;
  }

  lookup(input: {
    libraryId: string;
    sessionId: string;
    libraryGeneration: number;
    changeSequence: number;
  }): BrowseSessionLookup {
    const session = this.#sessions.get(input.sessionId);
    if (!session || session.libraryId !== input.libraryId) return { status: 'missing' };
    if (session.libraryGeneration !== input.libraryGeneration) {
      this.#sessions.delete(input.sessionId);
      return { status: 'stale', reason: 'library-generation' };
    }
    if (session.changeSequence !== input.changeSequence) {
      this.#sessions.delete(input.sessionId);
      return { status: 'stale', reason: 'change-sequence' };
    }
    this.#sessions.delete(input.sessionId);
    this.#sessions.set(input.sessionId, session);
    return { status: 'ready', session };
  }

  close(libraryId: string, sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session?.libraryId === libraryId) this.#sessions.delete(sessionId);
  }

  invalidateLibrary(libraryId: string): void {
    for (const [sessionId, session] of this.#sessions) {
      if (session.libraryId === libraryId) this.#sessions.delete(sessionId);
    }
  }

  clear(): void {
    this.#sessions.clear();
  }

  get size(): number {
    return this.#sessions.size;
  }

  #evictOldest(): void {
    while (this.#sessions.size > this.#limit) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest === undefined) return;
      this.#sessions.delete(oldest);
    }
  }
}

/** Canonical, order-stable fingerprint for a browse definition. */
export function browseQueryFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
