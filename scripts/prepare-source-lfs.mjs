import { open, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = 'public/companion-call';
const pointerHeader = 'version https://git-lfs.github.com/spec/v1';

/** Git checkouts made with smudging disabled must not ship pointer text as art. */
export async function prepareSourceLfs(root, runGit = args => spawnSync('git', args, {
  cwd: root, stdio: 'inherit', windowsHide: true,
})) {
  const modelSource = await readFile(path.join(root, sourceDirectory, 'models.json'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!modelSource) return { verified: 0, hydrated: false };
  const registry = JSON.parse(modelSource);
  const reference = relative => {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || /[:\\]/u.test(relative)
      || relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Unsafe built-in Live2D source reference.');
    return relative;
  };
  const manifests = Object.values(registry).map(entry => reference(entry.model));
  const required = [];
  for (const name of manifests) {
    const model = JSON.parse(await readFile(path.join(root, sourceDirectory, name), 'utf8'));
    const folder = path.posix.dirname(name);
    for (const file of [model.FileReferences.Moc, ...model.FileReferences.Textures]) required.push(path.posix.join(folder, reference(file)));
  }
  if (registry['yachiyo-runami']) required.push('yachiyo/portrait.png');
  const inspect = async () => {
    const pending = [];
    for (const relative of required) {
      const file = path.join(root, sourceDirectory, relative);
      let handle;
      try {
        const info = await stat(file);
        if (!info.isFile()) throw new Error(`Expected source file: ${relative}`);
        handle = await open(file, 'r');
        const buffer = Buffer.alloc(128);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead < 4 || buffer.subarray(0, bytesRead).toString('utf8').startsWith(pointerHeader)) pending.push(relative);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        pending.push(relative);
      } finally { await handle?.close(); }
    }
    return pending;
  };
  if (!(await inspect()).length) return { verified: required.length, hydrated: false };
  const instruction = 'Install Git LFS with Git for Windows, clone the official repository, then run 01-Setup-Environment.bat again. Source ZIP downloads may contain LFS pointers.';
  const available = runGit(['lfs', 'version']);
  if (available.error || available.status !== 0) throw new Error(`Built-in Live2D source assets need Git LFS. ${instruction}`);
  const include = [...new Set(manifests.map(name => sourceDirectory + '/' + path.posix.dirname(name) + '/**'))].join(',');
  const pull = runGit(['lfs', 'pull', '--include=' + include, '--exclude=']);
  if (pull.error || pull.status !== 0 || (await inspect()).length) throw new Error(`Git LFS could not materialize built-in Live2D source assets. Check the network/proxy. ${instruction}`);
  return { verified: required.length, hydrated: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  prepareSourceLfs(root).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
