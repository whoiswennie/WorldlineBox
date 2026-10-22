import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test } from '@playwright/test';

import { McpClientCredentialStore, parseCurrentUserSid } from '../../src/main/mcp-client-credentials';

import {
  electronLaunchEnv,
  resolveElectronExecutablePath,
} from './electron-test-helpers';

test.describe.configure({ timeout: 120_000 });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('Failed to allocate a test port.'));
        return;
      }
      probe.close((error) => error === undefined ? resolve(address.port) : reject(error));
    });
  });
}

test('Desktop embedded MCP exposes and reconnects over authenticated HTTP', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-mcp-http-e2e-'));
  const port = await freePort();
  writeFileSync(path.join(temporaryRoot, 'mcp-settings.json'), JSON.stringify({
    version: 1,
    preferences: { enabled: true, autoStart: true, port },
  }));
  // Electron's app.getPath('userData') is redirected by the E2E harness; keep
  // the settings beside the profile rather than touching the developer's
  // real MCP token/configuration files.
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const executablePath = resolveElectronExecutablePath();
  const application = await electron.launch({
    executablePath,
    args: [applicationDirectory],
    cwd: applicationDirectory,
    env: electronLaunchEnv({
      WORLDLINEBOX_E2E: '1',
      WORLDLINEBOX_E2E_HIDE_WINDOW: '1',
      WORLDLINEBOX_E2E_USER_DATA_PATH: temporaryRoot,
    }),
  });
  const window = await application.firstWindow();
  await window.evaluate(async () => {
    const bridge = (globalThis as typeof globalThis & {
      worldlinebox: {
        mcp: {
          request(input: { type: 'create-client-config'; input: { format: 'generic-json' } }): Promise<{
            ok: boolean;
            error?: { message?: string };
          }>;
        };
      };
    }).worldlinebox;
    const response = await bridge.mcp.request({
      type: 'create-client-config',
      input: { format: 'generic-json' },
    });
    if (!response.ok) throw new Error(response.error?.message ?? 'Could not create MCP config.');
  });
  const connectionText = await application.evaluate(({ clipboard }) => clipboard.readText());
  const endpointMatch = connectionText.match(/^Endpoint: (https?:\/\/\S+)$/mu);
  const tokenMatch = connectionText.match(/^Authorization: Bearer (\S+)$/mu);
  if (endpointMatch?.[1] === undefined || tokenMatch?.[1] === undefined) {
    throw new Error('The copied MCP connection did not include an endpoint and bearer token.');
  }
  const endpoint = endpointMatch[1];
  const token = tokenMatch[1];

  try {
    const client = new Client({ name: 'worldlinebox-mcp-http-e2e', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'worldlinebox_library_list_open',
      'worldlinebox_library_create',
      'worldlinebox_asset_search',
    ]));
    const listed = await client.callTool({
      name: 'worldlinebox_library_list_open',
      arguments: {},
    });
    expect(listed).toBeDefined();
    await client.close();
    await transport.close();

    const reconnected = new Client({ name: 'worldlinebox-mcp-http-e2e-reconnect', version: '1.0.0' });
    const reconnectTransport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await reconnected.connect(reconnectTransport);
    const reconnectedTools = await reconnected.listTools();
    expect(reconnectedTools.tools.map((tool) => tool.name)).toContain('worldlinebox_library_list_open');
    await reconnected.close();
    await reconnectTransport.close();
  } finally {
    await application.close();
    try {
      rmSync(temporaryRoot, {
        force: true,
        recursive: true,
        maxRetries: 20,
        retryDelay: 250,
      });
    } catch {
      // Windows may release Chromium cache handles shortly after the child tree exits.
    }
  }
});

test('Desktop MCP startup repairs an unreadable existing pepper without rotating its key', async () => {
  test.skip(process.platform !== 'win32', 'Windows ACL repair is specific to Windows.');

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-mcp-pepper-acl-e2e-'));
  const pepperPath = path.join(temporaryRoot, 'mcp-client-credential-pepper');
  let currentSid: string | undefined;
  let issued: ReturnType<McpClientCredentialStore['issue']> | undefined;
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    const whoami = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (whoami.error !== undefined || whoami.status !== 0) {
      throw whoami.error ?? new Error('Could not identify the E2E Windows user.');
    }
    currentSid = parseCurrentUserSid(whoami.stdout);
    issued = new McpClientCredentialStore(temporaryRoot).issue('Preserved E2E client');

    const restricted = spawnSync('icacls.exe', [
      pepperPath,
      '/inheritance:r',
      '/remove:g',
      `*${currentSid}`,
      '/grant:r',
      '*S-1-5-18:F',
    ], { stdio: 'ignore', windowsHide: true });
    expect(restricted.error).toBeUndefined();
    expect(restricted.status).toBe(0);

    const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
    application = await electron.launch({
      executablePath: resolveElectronExecutablePath(),
      args: [applicationDirectory],
      cwd: applicationDirectory,
      env: electronLaunchEnv({
        WORLDLINEBOX_E2E: '1',
        WORLDLINEBOX_E2E_HIDE_WINDOW: '1',
        WORLDLINEBOX_E2E_USER_DATA_PATH: temporaryRoot,
      }),
    });
    const window = await application.firstWindow();
    const response = await window.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & {
        worldlinebox: {
          mcp: {
            request(input: { type: 'get' }): Promise<{
              ok: boolean;
              code?: string;
              snapshot?: { credentials: Array<{ credentialId: string }> };
            }>;
          };
        };
      }).worldlinebox;
      return bridge.mcp.request({ type: 'get' });
    });

    expect(response.ok, response.code).toBe(true);
    expect(response.snapshot?.credentials.map((credential) => credential.credentialId))
      .toContain(issued.credentialId);

    await application.close();
    application = undefined;
    expect(new McpClientCredentialStore(temporaryRoot).tokenFor(issued.credentialId)).toBe(issued.token);
  } finally {
    if (application !== undefined) await application.close();
    if (currentSid !== undefined) {
      spawnSync('icacls.exe', [pepperPath, '/grant:r', `*${currentSid}:F`], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    rmSync(temporaryRoot, {
      force: true,
      recursive: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
});

test('Desktop MCP settings reports an invalid key file separately from an unauthorized sender', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-mcp-pepper-invalid-e2e-'));
  const pepperPath = path.join(temporaryRoot, 'mcp-client-credential-pepper');
  const originalPepper = Buffer.alloc(31, 0x23);
  writeFileSync(pepperPath, originalPepper);
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

  try {
    application = await electron.launch({
      executablePath: resolveElectronExecutablePath(),
      args: [applicationDirectory],
      cwd: applicationDirectory,
      env: electronLaunchEnv({
        WORLDLINEBOX_E2E: '1',
        WORLDLINEBOX_E2E_HIDE_WINDOW: '1',
        WORLDLINEBOX_E2E_USER_DATA_PATH: temporaryRoot,
      }),
    });
    const window = await application.firstWindow();
    const response = await window.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & {
        worldlinebox: {
          mcp: {
            request(input: { type: 'get' }): Promise<{
              ok: boolean;
              code?: string;
              message?: string;
              details?: { filePath: string; systemCode?: string };
            }>;
          };
        };
      }).worldlinebox;
      return bridge.mcp.request({ type: 'get' });
    });

    expect(response).toMatchObject({
      ok: false,
      code: 'MCP_CREDENTIAL_INVALID',
      details: { filePath: pepperPath },
    });
    expect(response.code).not.toBe('unauthorized_sender');
    expect(response.message).toContain('invalid length');
    expect(readFileSync(pepperPath)).toEqual(originalPepper);
  } finally {
    if (application !== undefined) await application.close();
    rmSync(temporaryRoot, {
      force: true,
      recursive: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  }
});
