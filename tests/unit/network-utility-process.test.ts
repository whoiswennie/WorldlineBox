import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NetworkEnvironment } from '../../src/shared/network-environment';

const harness = vi.hoisted(() => ({ environment: undefined as NetworkEnvironment | undefined,
  listener: undefined as ((environment: NetworkEnvironment) => void) | undefined, stop: vi.fn(), fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: harness.fork } }));
vi.mock('../../src/main/application-network', () => ({ currentNetworkEnvironment: () => harness.environment,
  onNetworkEnvironment: (listener: (environment: NetworkEnvironment) => void) => { harness.listener = listener; return harness.stop; } }));
import { forkNetworkUtility } from '../../src/main/network-utility-process';

const direct: NetworkEnvironment = { NO_PROXY: 'localhost,127.0.0.1,::1', npm_config_registry: 'https://registry.npmjs.org',
  PIP_INDEX_URL: 'https://pypi.org/simple', NODE_USE_ENV_PROXY: '1' };

describe('network policy binding for managed runtime utilities', () => {
  beforeEach(() => { harness.environment = direct; harness.listener = undefined; harness.stop.mockClear(); harness.fork.mockReset(); });

  it('pins an explicit initial environment and updates an already running child until its exit', () => {
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn() }); harness.fork.mockReturnValue(child);
    const created = forkNetworkUtility('/runtime.cjs', { serviceName: 'test utility', env: { http_proxy: 'http://stale:1', NODE_EXTRA: 'retained' } });
    expect(created).toBe(child);
    expect(harness.fork).toHaveBeenCalledWith('/runtime.cjs', [], expect.objectContaining({ env: { ...direct, NODE_EXTRA: 'retained' } }));
    const enabled = { ...direct, HTTP_PROXY: 'http://127.0.0.1:7896', HTTPS_PROXY: 'http://127.0.0.1:7896' };
    harness.environment = enabled; child.emit('spawn');
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'worker.network-environment', environment: enabled });
    harness.listener!(direct);
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'worker.network-environment', environment: direct });
    child.emit('exit', 0); expect(harness.stop).toHaveBeenCalledOnce();
  });

  it('isolates IPC sends racing a crashed child from the global policy save', () => {
    const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(() => { throw new Error('Process exited'); }) }); harness.fork.mockReturnValue(child);
    forkNetworkUtility('/runtime.cjs', { serviceName: 'test utility' });
    expect(() => child.emit('spawn')).not.toThrow(); expect(() => harness.listener!(direct)).not.toThrow();
  });
});
