import { describe, expect, it } from 'vitest';

import { RawMetadataBackfillAdmissionGate } from '../../src/worker/raw-metadata-backfill-gate';

const EMPTY = { admitted: 0, probed: 0, budgetCapped: false };
const CAPPED = { admitted: 0, probed: 0, budgetCapped: true };

describe('RawMetadataBackfillAdmissionGate', () => {
  it('bounds full-catalog probes per library', () => {
    const gate = new RawMetadataBackfillAdmissionGate();

    expect(gate.shouldAttempt('alpha', null, 1_000)).toBe(true);
    gate.noteResult('alpha', null, CAPPED, 1_000);

    expect(gate.shouldAttempt('alpha', null, 2_999)).toBe(false);
    expect(gate.remainingDelayMs('alpha', 2_999)).toBe(1);
    expect(gate.shouldAttempt('alpha', null, 3_000)).toBe(true);
  });

  it('keeps independent libraries and clears throttle state on close', () => {
    const gate = new RawMetadataBackfillAdmissionGate();
    gate.noteResult('alpha', null, CAPPED, 10_000);

    expect(gate.shouldAttempt('beta', null, 10_000)).toBe(true);
    expect(gate.shouldAttempt('alpha', null, 10_001)).toBe(false);

    gate.cancel('alpha');
    expect(gate.shouldAttempt('alpha', null, 10_001)).toBe(true);
  });

  it('stops probing for 100 consecutive turns once the catalog is drained', () => {
    const gate = new RawMetadataBackfillAdmissionGate();
    gate.noteResult('alpha', '7:9', EMPTY, 0);

    // WorldlineBox-288cd9 acceptance: no timer-driven rescan after an empty probe.
    for (let turn = 0; turn < 100; turn += 1) {
      expect(gate.shouldAttempt('alpha', '7:9', 60_000 + turn * 1_000)).toBe(false);
    }
    expect(gate.stats()).toMatchObject({
      attempts: 1,
      exhaustedSkips: 100,
      exhaustedLibraries: 1,
    });
    expect(gate.isExhausted('alpha', '7:9')).toBe(true);
  });

  it('re-arms precisely when the validation token changes', () => {
    const gate = new RawMetadataBackfillAdmissionGate();
    gate.noteResult('alpha', '7:9', EMPTY, 0);
    expect(gate.shouldAttempt('alpha', '7:9', 60_000)).toBe(false);

    // Any of: new asset / revision change / retry (library sequence) or an
    // ignore-rule change (browse sequence) produces a new token.
    expect(gate.shouldAttempt('alpha', '8:9', 60_000)).toBe(true);
    expect(gate.shouldAttempt('alpha', '7:10', 60_000)).toBe(true);

    // Without a token (lenient/older library) the gate degrades to throttling.
    gate.noteResult('alpha', '8:9', EMPTY, 60_000);
    expect(gate.shouldAttempt('alpha', null, 60_001)).toBe(false);
    expect(gate.shouldAttempt('alpha', null, 62_000)).toBe(true);
  });

  it('rehydrates a durable exhausted token after Worker restart', () => {
    const gate = new RawMetadataBackfillAdmissionGate();
    gate.restore('alpha', { exhaustedToken: '7:9' }, 1_000);

    expect(gate.hasState('alpha')).toBe(true);
    expect(gate.shouldAttempt('alpha', '7:9', 1_001)).toBe(false);
    expect(gate.shouldAttempt('alpha', '8:9', 1_001)).toBe(true);
  });

  it('never treats a cap-limited probe as drained', () => {
    const gate = new RawMetadataBackfillAdmissionGate();
    gate.noteResult('alpha', '7:9', CAPPED, 0);

    expect(gate.isExhausted('alpha', '7:9')).toBe(false);
    // Still throttled between attempts, but the next window probes again even
    // though nothing about the catalogue changed.
    expect(gate.shouldAttempt('alpha', '7:9', 1_999)).toBe(false);
    expect(gate.shouldAttempt('alpha', '7:9', 2_000)).toBe(true);
    expect(gate.stats()).toMatchObject({ attempts: 1, exhaustedSkips: 0 });
  });

  it('tracks exhausted libraries independently and clears them on close', () => {
    const gate = new RawMetadataBackfillAdmissionGate();
    gate.noteResult('alpha', '7:9', { admitted: 12, probed: 12, budgetCapped: true }, 0);
    expect(gate.stats()).toMatchObject({ attempts: 1, exhaustedLibraries: 0 });

    gate.noteResult('beta', '1:1', EMPTY, 0);
    expect(gate.stats().exhaustedLibraries).toBe(1);
    gate.cancel('beta');
    expect(gate.stats().exhaustedLibraries).toBe(0);
  });
});
