import { execFileSync } from 'node:child_process';

// The SQLite suite itself runs in Electron. Child CLI fixtures require a real
// Node executable: production deliberately removes Electron's run-as-Node flag.
const node = JSON.parse(execFileSync(process.env.npm_node_execpath || 'node',
  ['-p', 'JSON.stringify({executable:process.execPath,version:process.versions.node})'],
  { encoding: 'utf8', windowsHide: true, timeout: 10000 })) as { executable: string; version: string };
export const TEST_NODE_EXECUTABLE = node.executable;
export const TEST_NODE_VERSION = node.version;
