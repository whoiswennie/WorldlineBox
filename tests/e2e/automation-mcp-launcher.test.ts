import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron as electron, expect, test } from '@playwright/test';

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
  const configText = await application.evaluate(({ clipboard }) => clipboard.readText());
  const parsedConfig = JSON.parse(configText) as {
    mcpServers: { worldlinebox: { url: string; headers: { Authorization: string } } };
  };
  const endpoint = parsedConfig.mcpServers.worldlinebox.url;
  const token = parsedConfig.mcpServers.worldlinebox.headers.Authorization.replace(/^Bearer /u, '');

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
