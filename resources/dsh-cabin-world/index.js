import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';

export const name = 'worldlinebox-cabin-world';
export const inject = ['tools'];

export async function apply(ctx) {
  const home = process.env.DSH_HOME;
  if (!home || !path.isAbsolute(home)) throw new Error('Cabin World requires an absolute DSH_HOME.');
  const configFile = path.join(home, 'plugin-data', 'worldlinebox-cabin-world', 'config.json');
  let config;
  try {
    config = JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`无法读取小屋世界插件配置 ${configFile}，请设置 bridgeJson。`, { cause: error });
  }
  if (typeof config?.bridgeJson !== 'string' || !path.isAbsolute(config.bridgeJson)) {
    throw new Error(`请在 ${configFile} 的 bridgeJson 中填写小屋世界 data/bridge.json 的绝对路径。`);
  }

  const child = ctx.plugin(McpClient, McpClient.Config({
    serverName: 'cabin_world',
    transport: 'stdio',
    command: process.execPath,
    args: [fileURLToPath(new URL('./server.js', import.meta.url)), config.bridgeJson, ...(config.toolDefinitions ? [config.toolDefinitions] : [])],
    toolCallTimeoutMs: 65000,
    failOnStartupError: true,
  }));
  await child.await();
}
