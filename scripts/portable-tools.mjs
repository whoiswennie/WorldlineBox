import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(projectRoot, 'resources/portable-tools/win32-x64');
const lockPath = path.join(projectRoot, 'resources/portable-tools/tool-lock.json');
const command = process.argv[2] ?? 'verify';
const options = new Map();
for (let index = 3; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith('--') || !value) throw new Error('Expected --option value.');
  options.set(name.slice(2), value);
}
const targetRoot = options.has('root') ? path.resolve(options.get('root')) : root;

async function hash(file) {
  const handle = await open(file, 'r');
  try {
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest('hex');
  } finally { await handle.close(); }
}

async function inventory(directory, prefix = '') {
  const files = [];
  async function scan(current, currentPrefix) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = currentPrefix ? `${currentPrefix}/${entry.name}` : entry.name;
      if (relative === 'manifest.json') continue;
      const file = path.join(current, entry.name);
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error(`Portable tool payload cannot contain links: ${relative}`);
      if (info.isDirectory()) await scan(file, relative);
      else if (info.isFile()) files.push({ file, path: relative, size: info.size, sha256: '' });
      else throw new Error(`Portable tool payload has unsupported entry: ${relative}`);
    }
  }
  await scan(directory, prefix);
  // Preserve manifest ordering while hashing a bounded number of files at once.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      const entry = files[next++];
      entry.sha256 = await hash(entry.file);
    }
  }));
  return files.map(({ path: relative, size, sha256 }) => ({ path: relative, size, sha256 }));
}

function toolRun(directory, tool, args, expected, env) {
  const result = spawnSync(path.join(directory, tool), args, {
    cwd: directory, env, windowsHide: true, shell: false, encoding: 'utf8', timeout: 30_000,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0 || !expected.test(output)) throw new Error(`Bundled tool verification failed: ${tool} (${result.status}): ${output.slice(0, 700)}`);
  return output.split(/\r?\n/)[0];
}

function toolEnvironment(directory) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PATH|PYTHONHOME|PYTHONPATH|GIT_EXEC_PATH|GIT_SSL_CAINFO|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete env[key];
  env.PATH = ['node', 'pnpm', 'python', 'python/Scripts', 'git/cmd', 'git/mingw64/bin', 'git/usr/bin', 'ffmpeg/bin'].map((value) => path.join(directory, value)).join(path.delimiter);
  env.PATH += `${path.delimiter}${path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}`;
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONUTF8 = '1';
  env.GIT_EXEC_PATH = path.join(directory, 'git/mingw64/libexec/git-core');
  env.GIT_SSL_CAINFO = path.join(directory, 'git/mingw64/etc/ssl/certs/ca-bundle.crt');
  return env;
}

function verifyVersions(directory) {
  const env = toolEnvironment(directory);
  const versions = {
    node: toolRun(directory, 'node/node.exe', ['--version'], /^v24\.15\.0$/, env),
    npm: toolRun(directory, 'node/node.exe', ['node/node_modules/npm/bin/npm-cli.js', '--version'], /^11\.12\.1$/, env),
    pnpm: toolRun(directory, 'node/node.exe', ['pnpm/bin/pnpm.cjs', '--version'], /^11\.7\.0$/, env),
    python: toolRun(directory, 'python/python.exe', ['--version'], /^Python 3\.13\.12$/, env),
    git: toolRun(directory, 'git/cmd/git.exe', ['--version'], /^git version 2\.48\.1\.windows\.1$/, env),
    ffmpeg: toolRun(directory, 'ffmpeg/bin/ffmpeg.exe', ['-version'], /^ffmpeg version 8\.0\.1-essentials_build/, env),
    ffplay: toolRun(directory, 'ffmpeg/bin/ffplay.exe', ['-version'], /^ffplay version 8\.0\.1-essentials_build/, env),
    ffprobe: toolRun(directory, 'ffmpeg/bin/ffprobe.exe', ['-version'], /^ffprobe version 8\.0\.1-essentials_build/, env),
  };
  toolRun(directory, 'python/python.exe', ['-B', '-I', '-c', 'import ensurepip, venv, ssl, sqlite3; print("PYTHON_STDLIB_OK")'], /^PYTHON_STDLIB_OK$/, env);
  toolRun(directory, 'python/python.exe', ['-B', '-I', '-m', 'pip', '--version'], /^pip 25\.3 /, env);
  return versions;
}

async function verify(directory, allowDevelopmentCaches = false) {
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (await hash(path.join(directory, 'manifest.json')) !== lock.manifestSha256) throw new Error('Portable tool manifest does not match the committed tool lock. Run tools:stage with reviewed sources.');
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const actual = await inventory(directory);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    const expected = new Map(manifest.files.map(file => [file.path, file]));
    const byPath = new Map(actual.map(file => [file.path, file]));
    const knownFilesMatch = manifest.files.every(file => JSON.stringify(byPath.get(file.path)) === JSON.stringify(file));
    const extras = actual.filter(file => !expected.has(file.path));
    const generatedStdlibCaches = extras.every(file => {
      const match = /^python\/Lib\/(.*?)__pycache__\/([^.]+)\.cpython-313(?:\.opt-\d)?\.pyc$/.exec(file.path);
      return match && expected.has(`python/Lib/${match[1]}${match[2]}.py`);
    });
    if (!allowDevelopmentCaches || !knownFilesMatch || !generatedStdlibCaches) throw new Error('Portable tool file inventory/SHA-256 mismatch.');
    console.log(JSON.stringify({ developmentCachesPreserved: extras.map(file => file.path), reviewedToolFilesUnchanged: true }));
  }
  console.log(JSON.stringify({ portableTools: verifyVersions(directory), files: actual.length, bytes: actual.reduce((sum, file) => sum + file.size, 0) }, null, 2));
}

async function prepareRelease() {
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (await hash(path.join(root, 'manifest.json')) !== lock.manifestSha256) throw new Error('Portable tool manifest differs from its source lock.');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const actual = await inventory(root); const byPath = new Map(actual.map(file => [file.path, file]));
  for (const file of manifest.files) {
    if (JSON.stringify(byPath.get(file.path)) !== JSON.stringify(file)) throw new Error(`Reviewed portable tool changed: ${file.path}`);
  }
  // Export precisely the locked files. Runtime caches in the development copy are
  // left untouched and never silently promoted into the distributed tool payload.
  const releaseParent = path.join(projectRoot, '.tools', 'portable-release');
  const releaseResources = path.resolve(options.get('release-root') ?? path.join(releaseParent, 'reviewed', 'resources'));
  const relativeRelease = path.relative(releaseParent, releaseResources);
  if (!relativeRelease || relativeRelease.startsWith('..') || path.isAbsolute(relativeRelease) || path.basename(releaseResources) !== 'resources') throw new Error('Invalid portable release resource root.');
  const release = path.join(releaseResources, 'portable-tools', 'win32-x64');
  const directories = new Set();
  async function directory(value) {
    if (directories.has(value)) return;
    if (value !== projectRoot) await directory(path.dirname(value));
    if (!path.resolve(value).startsWith(`${projectRoot}${path.sep}`) && value !== projectRoot) throw new Error('Portable release path escaped the project.');
    await mkdir(value, { recursive: true }); const info = await lstat(value);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Portable release cannot contain linked directories.');
    directories.add(value);
  }
  for (const file of [...manifest.files, { path: 'manifest.json' }]) {
    if (!file.path || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid reviewed tool path.');
    const destination = path.resolve(release, file.path);
    if (!destination.startsWith(`${release}${path.sep}`)) throw new Error('Tool destination escaped its release directory.');
    await directory(path.dirname(destination));
    const existing = await lstat(destination).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('A portable release file is linked or invalid.');
    await copyFile(path.join(root, file.path), destination);
  }
  await copyFile(lockPath, path.join(path.dirname(release), 'tool-lock.json'));
  for (const entry of await readdir(path.join(projectRoot, 'resources'), { withFileTypes: true })) {
    if (entry.name === 'portable-tools') continue;
    await cp(path.join(projectRoot, 'resources', entry.name), path.join(releaseResources, entry.name), { recursive: true, dereference: false });
  }
  await verify(release);
  const approved = new Set(manifest.files.map(file => file.path));
  console.log(JSON.stringify({ portableRelease: release, unshippedDevelopmentFiles: actual.filter(file => !approved.has(file.path)).map(file => file.path) }));
}

async function safeRemoveOwned(directory, parent) {
  const resolved = path.resolve(directory);
  const resolvedParent = await realpath(parent);
  if (!resolved.startsWith(`${resolvedParent}${path.sep}`)) throw new Error('Refusing cleanup outside the owned staging directory.');
  await rm(resolved, { recursive: true, force: true });
}

async function stage() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This portable tool bundle targets Windows x64.');
  const nodeSource = path.resolve(options.get('node') ?? path.join(projectRoot, '.tools/node-v24.15.0-win-x64'));
  const pythonSource = path.resolve(options.get('python') ?? process.env.WORLDLINEBOX_PYTHON_SOURCE ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Python/Python313'));
  const gitSource = path.resolve(options.get('git') ?? process.env.WORLDLINEBOX_GIT_SOURCE ?? 'C:/Program Files/Git');
  const ffmpegSource = path.resolve(options.get('ffmpeg') ?? process.env.WORLDLINEBOX_FFMPEG_SOURCE ?? path.join(process.env.USERPROFILE ?? '', 'Desktop/备份/env/ffmpeg-8.0.1-essentials_build'));
  const pnpmSource = path.resolve(options.get('pnpm') ?? path.join(projectRoot, '.tools/dsh-research/extracted/resources/runtime/pnpm'));
  const stagingParent = path.join(projectRoot, '.tools/portable-tool-staging');
  await mkdir(stagingParent, { recursive: true });
  const staging = await mkdtemp(path.join(stagingParent, 'bundle-'));
  try {
    const copy = async (source, destination) => cp(source, destination, { recursive: true, dereference: false, filter: async (file) => {
      const info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error('Portable source contains a symbolic link.');
      return !file.split(path.sep).some((component) => component === '__pycache__' || component === '.git');
    } });
    await copy(nodeSource, path.join(staging, 'node'));
    await copy(pnpmSource, path.join(staging, 'pnpm'));
    await writeFile(path.join(staging, 'pnpm/pnpm.cmd'), '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0bin\\pnpm.cjs" %*\r\n');
    await mkdir(path.join(staging, 'python'), { recursive: true });
    for (const entry of await readdir(pythonSource, { withFileTypes: true })) {
      if (['Lib', 'DLLs', 'include', 'libs', 'tcl'].includes(entry.name) || /^(python(?:w|3|313)?\.(?:exe|dll)|vcruntime140(?:_1)?\.dll|LICENSE\.txt)$/i.test(entry.name)) {
        await cp(path.join(pythonSource, entry.name), path.join(staging, 'python', entry.name), { recursive: true, filter: async (file) => {
          const relative = path.relative(pythonSource, file).replaceAll('\\', '/');
          const info = await lstat(file);
          if (info.isSymbolicLink()) throw new Error('Python source contains a symbolic link.');
          if (relative.split('/').includes('__pycache__')) return false;
          const sitePart = relative.match(/^Lib\/site-packages\/([^/]+)/);
          return !sitePart || /^(pip|pip-25\.3\.dist-info)$/.test(sitePart[1]);
        } });
      }
    }
    await mkdir(path.join(staging, 'python/Scripts'), { recursive: true });
    await writeFile(path.join(staging, 'python/Scripts/pip.cmd'), '@echo off\r\n"%~dp0..\\python.exe" -m pip %*\r\n');
    // Copy portable Git components, never an uninstaller, user config or install registry.
    for (const component of ['cmd', 'bin', 'mingw64', 'usr', 'LICENSE.txt']) await copy(path.join(gitSource, component), path.join(staging, 'git', component));
    // PortableGit does not include the installed edition's ReleaseNotes.html.
    const releaseNotes = path.join(gitSource, 'ReleaseNotes.html');
    const notes = await lstat(releaseNotes).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (notes) await copy(releaseNotes, path.join(staging, 'git/ReleaseNotes.html'));
    await mkdir(path.join(staging, 'git/etc'), { recursive: true });
    await writeFile(path.join(staging, 'git/etc/gitconfig'), '[core]\n\tautocrlf = false\n[http]\n\tsslBackend = openssl\n');
    for (const component of ['bin', 'doc', 'presets', 'LICENSE', 'README.txt']) await copy(path.join(ffmpegSource, component), path.join(staging, 'ffmpeg', component));
    await writeFile(path.join(staging, 'SOURCES.md'), '# Bundled command line tools\n\nThese are independent tools invoked as child processes. No system installation or global environment change is required.\n\n- Node.js 24.15.0 + npm 11.12.1: https://nodejs.org/dist/v24.15.0/ ; licenses in node/LICENSE and npm package.\n- CPython 3.13.12 + pip 25.3: https://www.python.org/downloads/release/python-31312/ ; PSF license in python/LICENSE.txt. Full Lib, ensurepip and venv are included.\n- Git for Windows 2.48.1.windows.1: https://github.com/git-for-windows/git/releases/tag/v2.48.1.windows.1 ; GPLv2 and component notices remain in git/LICENSE.txt and git/usr/share/licenses. Corresponding source distribution: https://github.com/git-for-windows/git/archive/refs/tags/v2.48.1.windows.1.tar.gz .\n- FFmpeg/ffplay/ffprobe 8.0.1 essentials: https://www.gyan.dev/ffmpeg/builds/ ; GPLv3 license and original exact build configuration are included as ffmpeg/LICENSE and ffmpeg/README.txt. Upstream source commit is https://github.com/FFmpeg/FFmpeg/commit/894da5ca7d and Gyan build/source information is https://www.gyan.dev/ffmpeg/builds/#source-code .\n\nThe LGPL media bundle used by the asset worker remains separately verified. This GPL command bundle is not a replacement for it. Public binary distribution must provide the corresponding source for Git/FFmpeg and their enabled linked components alongside the binaries as their licenses require.\n');
    if (options.has('download-lock')) {
      // Checkout line endings must not change the reproducible payload bytes.
      const downloads = JSON.parse(await readFile(path.resolve(options.get('download-lock')), 'utf8'));
      await writeFile(path.join(staging, 'DOWNLOADS.json'), `${JSON.stringify(downloads, null, 2)}\n`);
      const sourcesFile = path.join(staging, 'SOURCES.md');
      await writeFile(sourcesFile, `${await readFile(sourcesFile, 'utf8')}\nExact official archive URLs and SHA-256 checksums used for this reproducible bundle are recorded in DOWNLOADS.json. CPython comes from the official python.org NuGet package with its full standard library, pip and ensurepip.\n`);
    }
    const outputs = verifyVersions(staging);
    console.log('[portable-tools] Tool runtimes verified; hashing the complete file inventory...');
    const manifest = { format: 'worldlinebox-portable-tools-v1', platform: 'win32-x64', versions: { node: '24.15.0', npm: '11.12.1', pnpm: '11.7.0', python: '3.13.12', git: '2.48.1.windows.1', ffmpeg: '8.0.1' }, files: await inventory(staging) };
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestSha256 = await hash(path.join(staging, 'manifest.json'));
    if (options.get('locked') === 'true') {
      const approved = JSON.parse(await readFile(lockPath, 'utf8'));
      if (manifestSha256 !== approved.manifestSha256) throw new Error('Downloaded portable tools do not reproduce the reviewed manifest. The existing lock was not changed.');
    }
    await mkdir(path.dirname(root), { recursive: true });
    // Never replace an existing managed payload unless its verified manifest agrees.
    try {
      await lstat(root);
      throw new Error('Portable payload already exists. Verify it, or explicitly move the owned payload before staging a reviewed replacement.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (let attempt = 0; ; attempt += 1) {
      try { await rename(staging, root); break; }
      catch (error) {
        if (attempt === 8 || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
        await setTimeout(200 * (attempt + 1));
      }
    }
    if (options.get('locked') !== 'true') await writeFile(lockPath, `${JSON.stringify({ format: 'worldlinebox-portable-tools-lock-v1', platform: 'win32-x64', manifestSha256, versions: manifest.versions }, null, 2)}\n`);
    console.log(JSON.stringify({ staged: root, files: manifest.files.length, versions: outputs }, null, 2));
  } finally {
    await safeRemoveOwned(staging, stagingParent);
  }
}

if (command === 'manifest') {
  // Explicit promotion for reviewed local build inputs, never called by a release gate.
  verifyVersions(targetRoot);
  const current = JSON.parse(await readFile(path.join(targetRoot, 'manifest.json'), 'utf8'));
  current.files = await inventory(targetRoot);
  await writeFile(path.join(targetRoot, 'manifest.json'), `${JSON.stringify(current, null, 2)}\n`);
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.manifestSha256 = await hash(path.join(targetRoot, 'manifest.json'));
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
} else if (command === 'stage') await stage();
else if (command === 'release') await prepareRelease();
else if (command === 'verify' || command === 'ensure') await verify(targetRoot, command === 'ensure');
else throw new Error(`Unknown portable tools command: ${command}`);
