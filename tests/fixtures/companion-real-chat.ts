import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import type { CompanionModelConfig } from '../../src/main/companions/model';

/** Explicit opt-in content QA only. Reads exactly the global config and encrypted
 * key; app data for the decrypting Electron main process stays in the fixture.
 */
export async function realGlobalChatConfig(root: string): Promise<CompanionModelConfig> {
  const source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT ?? process.env.WORLDLINEBOX_USER_DATA_PATH ?? path.join(process.env.APPDATA!, 'WorldlineBox');
  const env: NodeJS.ProcessEnv = { ...process.env, WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT: source, WORLDLINEBOX_CONTENT_EVAL_PROFILE: path.join(root, 'chat-safe-profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const executable = createRequire(import.meta.url)('electron') as string;
  const child = spawn(executable, [path.resolve('tests/fixtures/companion-real-chat-host.cjs')], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let startupError = '';
  child.stderr?.on('data', bytes => { if (startupError.length < 4000) startupError += String(bytes); });
  return new Promise((resolve, reject) => {
    let delivered = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('GLOBAL_CHAT_CONFIG_TIMEOUT')); }, 15000);
    child.on('message', message => {
      if (!message || typeof message !== 'object' || !('ok' in message)) return;
      delivered = true; clearTimeout(timer);
      if (!message.ok) { reject(new Error('code' in message ? String(message.code) : 'GLOBAL_CHAT_CONFIG_UNREADABLE')); return; }
      if (!('stored' in message) || !message.stored || typeof message.stored !== 'object' || !('apiKey' in message) || typeof message.apiKey !== 'string' || !message.apiKey) { reject(new Error('GLOBAL_CHAT_CONFIG_EMPTY')); return; }
      resolve({ ...resolveStoredLlmConfig(message.stored), apiKey: message.apiKey });
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('GLOBAL_CHAT_CONFIG_START_FAILED')); });
    child.on('exit', code => { clearTimeout(timer); if (!delivered) reject(new Error(`GLOBAL_CHAT_CONFIG_PROCESS_EXITED_${code}: ${startupError.split('\n').find(line => /(?:Error|error):/u.test(line))?.slice(0, 250) ?? ''}`)); });
  });
}
