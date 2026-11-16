import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const tools = path.join(root, '.tools');
await mkdir(tools, { recursive: true });
const scratch = await mkdtemp(path.join(tools, 'dsh-release-build-'));
try {
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      ssr: path.join(import.meta.dirname, 'stage-bundled-dsh.ts'),
      target: 'node24',
      outDir: scratch,
      rollupOptions: { output: { entryFileNames: 'stage.mjs' } },
    },
  });
  const { stageBundledDsh } = await import(pathToFileURL(path.join(scratch, 'stage.mjs')).href);
  await stageBundledDsh(root, process.argv[2]);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
