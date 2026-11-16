import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'resources', 'dsh-cabin-world');
const target = path.join(root, '.tools', 'cabin-plugin-release', 'dsh-cabin-world');
await mkdir(target, { recursive: true });
await build({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  ssr: { noExternal: true },
  build: {
    ssr: path.join(source, 'server.js'), target: 'node24', outDir: target, emptyOutDir: true,
    rollupOptions: {
      output: { format: 'esm', entryFileNames: 'server.js', codeSplitting: false },
    },
  },
});
const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
delete manifest.dependencies;
for (const name of manifest.files) {
  if (name !== 'server.js') await copyFile(path.join(source, name), path.join(target, name));
}
await writeFile(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
