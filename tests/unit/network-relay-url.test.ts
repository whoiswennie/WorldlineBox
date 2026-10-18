import { describe, expect, it } from 'vitest';

import { isManagedNetworkRelayUrl } from '../../src/shared/network-relay-url';
import { networkEnvironmentSchema } from '../../src/shared/network-environment';

describe('internal relay environment capability validation', () => {
  const endpoint = `http://worldlinebox:${'a'.repeat(64)}@127.0.0.1:12345`;
  const environment = { NO_PROXY: 'localhost,127.0.0.1,::1', npm_config_registry: 'https://registry.npmjs.org',
    PIP_INDEX_URL: 'https://pypi.org/simple', NODE_USE_ENV_PROXY: '1' };

  it('accepts the private authenticated relay and ordinary credential-free HTTP proxies', () => {
    expect(isManagedNetworkRelayUrl(endpoint)).toBe(true);
    expect(networkEnvironmentSchema.safeParse({ ...environment, HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint }).success).toBe(true);
    expect(networkEnvironmentSchema.safeParse({ ...environment, HTTP_PROXY: 'http://127.0.0.1:7896' }).success).toBe(true);
  });

  it.each([
    endpoint.replace('127.0.0.1', 'localhost'), endpoint.replace('127.0.0.1', 'example.com'),
    endpoint.replace('worldlinebox:', 'another-user:'), endpoint.replace('a'.repeat(64), 'short'),
    endpoint.replace('http:', 'https:'), `${endpoint}/path`, `${endpoint}?secret=1`, `${endpoint}#fragment`,
    endpoint.replace(':12345', ''), endpoint.replace(':12345', ':0'), endpoint.replace(':12345', ':65536'),
    'socks5://127.0.0.1:7896',
  ])('rejects arbitrary credentials or a malformed internal relay route: %s', candidate => {
    expect(isManagedNetworkRelayUrl(candidate)).toBe(false);
    expect(networkEnvironmentSchema.safeParse({ ...environment, HTTP_PROXY: candidate }).success).toBe(false);
  });
});
