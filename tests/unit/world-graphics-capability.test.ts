import { describe, expect, it } from 'vitest';
import { evaluateWorldGraphicsCapability } from '../../src/shared/world-graphics-capability';

describe('optional world graphics admission', () => {
  it('requires an actual usable WebGL 2 context, not a browser or graphics vendor name', () => {
    expect(evaluateWorldGraphicsCapability({ webgl2: false, totalMemoryBytes: 32 * 1024 ** 3 })).toMatchObject({ status: 'unavailable', reasonCode: 'webgl2_unavailable' });
    expect(evaluateWorldGraphicsCapability({ webgl2: true, contextLost: true })).toMatchObject({ status: 'unavailable', reasonCode: 'context_lost' });
    expect(evaluateWorldGraphicsCapability({ webgl2: true, probeFailed: true })).toMatchObject({ status: 'unavailable', reasonCode: 'probe_failed' });
    expect(evaluateWorldGraphicsCapability({ webgl2: true })).toMatchObject({ status: 'available', webgl2: true });
  });
  it('uses a conservative explicit software memory budget and never treats unknown RAM as zero', () => {
    const low = evaluateWorldGraphicsCapability({ webgl2: true, totalMemoryBytes: 2 * 1024 ** 3, browserMemoryGiB: 8 });
    expect(low).toMatchObject({ status: 'unavailable', reasonCode: 'memory_insufficient', memoryGiB: 2, memorySource: 'system', minimumMemoryGiB: 4 });
    expect(low.reason).toContain('本软件');
    expect(evaluateWorldGraphicsCapability({ webgl2: true, totalMemoryBytes: 4 * 1024 ** 3 })).toMatchObject({ status: 'available', memoryGiB: 4 });
    expect(evaluateWorldGraphicsCapability({ webgl2: true, browserMemoryGiB: 2 })).toMatchObject({ status: 'unavailable', memorySource: 'browser' });
    expect(evaluateWorldGraphicsCapability({ webgl2: true, totalMemoryBytes: Number.NaN, browserMemoryGiB: Infinity })).not.toHaveProperty('memoryGiB');
    expect(evaluateWorldGraphicsCapability({ webgl2: true, totalMemoryBytes: 0 })).toHaveProperty('status', 'available');
  });
});
