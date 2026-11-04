import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBotMemoryNode, verifyBotMemory } from './bot-memory-runtime-lib.mjs';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
const packageRoot = argument('--package-root') || path.join(projectRoot, '.tools', 'bot-memory-release', 'vcp-memory');
try {
  const nodePath = await resolveBotMemoryNode(projectRoot, argument('--node'));
  console.log(JSON.stringify(await verifyBotMemory({ packageRoot, projectRoot, nodePath, compareSource: !process.argv.includes('--no-source-compare') })));
} catch (error) {
  console.error('Bot memory startup verification failed: ' + (error instanceof Error ? error.message : String(error)));
  console.error('Prepare the isolated module explicitly with: node scripts/stage-bot-memory.mjs');
  console.error('Use Node 24, or add --node="<managed DSH Node 24 executable>". Startup verification never installs or rewrites runtime dependencies.');
  process.exitCode = 1;
}
