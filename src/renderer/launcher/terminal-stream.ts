/** Offsets count UTF-16 code units in the redacted terminal stream. */
export interface TerminalStreamSnapshot {
  readonly text: string;
  readonly startOffset: number;
  readonly revision: number;
}

export interface TerminalStreamCursor {
  readonly endOffset: number;
  readonly revision: number;
  readonly tail: string;
}

export interface TerminalStreamUpdate {
  readonly reset: boolean;
  readonly text: string;
  readonly cursor: TerminalStreamCursor;
}

const CONTINUITY_TAIL = 128;

/**
 * A bounded backend ring is a transport snapshot, not a screen to rewrite on
 * every event. Consume only its new suffix, checking overlap after ring trims.
 * An explicit clear or a missed portion requires a fresh screen baseline.
 */
export function consumeTerminalSnapshot(snapshot: TerminalStreamSnapshot, previous?: TerminalStreamCursor): TerminalStreamUpdate {
  if (!Number.isSafeInteger(snapshot.startOffset) || snapshot.startOffset < 0
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('Invalid terminal stream snapshot.');
  const endOffset = snapshot.startOffset + snapshot.text.length;
  if (!Number.isSafeInteger(endOffset)) throw new Error('Terminal stream offset exceeds its supported range.');
  const cursor = { endOffset, revision: snapshot.revision, tail: snapshot.text.slice(-CONTINUITY_TAIL) };
  if (!previous || previous.revision !== snapshot.revision || previous.endOffset < snapshot.startOffset || previous.endOffset > endOffset) {
    return { reset: true, text: snapshot.text, cursor };
  }
  const overlapStart = Math.max(snapshot.startOffset, previous.endOffset - previous.tail.length);
  const overlap = snapshot.text.slice(overlapStart - snapshot.startOffset, previous.endOffset - snapshot.startOffset);
  const expected = previous.tail.slice(overlapStart - (previous.endOffset - previous.tail.length));
  if (overlap !== expected) return { reset: true, text: snapshot.text, cursor };
  return { reset: false, text: snapshot.text.slice(previous.endOffset - snapshot.startOffset), cursor };
}

/** Links emitted by a process cannot choose a local-file or application scheme. */
export function terminalExternalLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}
