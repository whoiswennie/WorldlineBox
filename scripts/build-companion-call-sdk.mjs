import { execFileSync } from 'node:child_process';
import path from 'node:path';
for (const name of ['engine', 'live2d-pixi']) execFileSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '-p', path.resolve('vendor/soullink-emotion', name, 'tsconfig.build.json')], { stdio: 'inherit', windowsHide: true });
