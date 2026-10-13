import { realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Windows accepts differently cased filenames, while Node caches ESM modules
 * by URL. Harness later canonicalizes its package roots: its initial CLI URL
 * must use that exact spelling too, or stateful services load twice and profile
 * reload cannot find the bootstrap Include registered by the other copy.
 */
export function canonicalRuntimeEntryPaths(directory: string, adapter = 'desktop-cli-web-v1'): { executable: string; cli: string } {
  // This is the physical program directory, never a virtual path within ASAR.
  const program = realpathSync.native(directory);
  if (adapter === 'node-cli-web-v1') return {
    executable: realpathSync.native(path.join(program, 'bin', 'node.exe')),
    cli: realpathSync.native(path.join(program, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')),
  };
  if (adapter !== 'desktop-cli-web-v1') throw new Error('Unsupported DSH runtime adapter.');
  return { executable: path.join(program, 'DeepSeek Harness.exe'),
    cli: path.join(program, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js') };
}
