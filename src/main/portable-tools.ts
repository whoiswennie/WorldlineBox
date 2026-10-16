import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import portableToolLock from '../../resources/portable-tools/tool-lock.json';

export interface PortableToolchain {
  rootPath: string;
  nodeExecutable: string;
  npmCli: string;
  nodeVersion: string;
  npmVersion: string;
  pnpmCli: string;
  pnpmVersion: string;
  pythonExecutable: string;
  pythonHome: string;
  gitExecutable: string;
  gitCaBundle: string;
  ffmpegExecutable: string;
  ffplayExecutable: string;
  ffprobeExecutable: string;
  pathDirectories: string[];
}

interface PortableManifest {
  format: 'worldlinebox-portable-tools-v1';
  versions: { node: string; npm: string; pnpm: string; python: string; git: string; ffmpeg: string };
  files: Array<{ path: string; size: number; sha256: string }>;
}

export interface PortableToolOptions {
  resourcesPath?: string;
  appPath?: string;
  platform?: string;
  signal?: AbortSignal;
  onProgress?: (progress: { completed: number; total: number; file: string }) => void;
}

function inside(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('PORTABLE_TOOLS_INVALID_MANIFEST');
  }
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('PORTABLE_TOOLS_INVALID_MANIFEST');
  return target;
}

async function verifyFile(root: string, entry: PortableManifest['files'][number], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const target = inside(root, entry.path);
  let current = root;
  for (const part of entry.path.split('/')) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('PORTABLE_TOOLS_LINK_FORBIDDEN');
  }
  const info = await lstat(target);
  if (!info.isFile() || info.size !== entry.size) throw new Error('PORTABLE_TOOLS_INTEGRITY_FAILED');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target, { signal })) hash.update(chunk as Buffer);
  if (hash.digest('hex') !== entry.sha256) throw new Error('PORTABLE_TOOLS_INTEGRITY_FAILED');
}

/** Bundled resources only. An unrelated executable found on PATH is never a fallback. */
export async function resolvePortableTools(options: PortableToolOptions = {}): Promise<PortableToolchain> {
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  if (platform !== 'win32-x64') throw new Error('PORTABLE_TOOLS_PLATFORM_UNAVAILABLE');
  const appPath = options.appPath ?? app.getAppPath();
  const resourcePath = options.resourcesPath ?? process.resourcesPath;
  const candidates = [
    path.join(resourcePath, 'resources', 'portable-tools', platform),
    path.join(resourcePath, 'portable-tools', platform),
    path.join(appPath, 'resources', 'portable-tools', platform),
  ];
  let root: string | undefined;
  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      await lstat(path.join(candidate, 'manifest.json'));
      root = await realpath(candidate);
      break;
    } catch { /* Try the next application-owned resource directory. */ }
  }
  if (!root) throw new Error('PORTABLE_TOOLS_REQUIRED: bundle the application tools before packaging.');
  const manifestBytes = await readFile(path.join(root, 'manifest.json'));
  if (createHash('sha256').update(manifestBytes).digest('hex') !== portableToolLock.manifestSha256) {
    throw new Error('PORTABLE_TOOLS_INTEGRITY_FAILED');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as PortableManifest;
  if (manifest.format !== 'worldlinebox-portable-tools-v1' || !Array.isArray(manifest.files) || !manifest.versions) {
    throw new Error('PORTABLE_TOOLS_INVALID_MANIFEST');
  }
  const locations = {
    nodeExecutable: 'node/node.exe', npmCli: 'node/node_modules/npm/bin/npm-cli.js',
    pnpmCli: 'pnpm/bin/pnpm.cjs',
    pythonExecutable: 'python/python.exe', gitExecutable: 'git/cmd/git.exe',
    gitCaBundle: 'git/mingw64/etc/ssl/certs/ca-bundle.crt', ffmpegExecutable: 'ffmpeg/bin/ffmpeg.exe',
    ffplayExecutable: 'ffmpeg/bin/ffplay.exe', ffprobeExecutable: 'ffmpeg/bin/ffprobe.exe',
  };
  // The complete payload is checked by the release gate; check executable entry points
  // again at runtime instead of rescanning the complete dependency tree.
  const entries = Object.values(locations).map(location => {
    const entry = manifest.files.find(item => item.path === location);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('PORTABLE_TOOLS_INVALID_MANIFEST');
    return entry;
  });
  let next = 0, completed = 0;
  // Bounded I/O parallelism. Every executable still receives its full SHA256 check;
  // no remembered success can bypass a changed or corrupted payload.
  const verified = await Promise.allSettled(Array.from({ length: Math.min(3, entries.length) }, async () => {
    while (next < entries.length) {
      const entry = entries[next++]!;
      await verifyFile(root!, entry, options.signal);
      options.onProgress?.({ completed: ++completed, total: entries.length, file: entry.path.split('/').at(-1)! });
    }
  }));
  const failure = verified.find((value): value is PromiseRejectedResult => value.status === 'rejected');
  if (failure) throw failure.reason;
  return {
    rootPath: root,
    ...Object.fromEntries(Object.entries(locations).map(([key, value]) => [key, inside(root!, value)])) as typeof locations,
    nodeVersion: manifest.versions.node,
    npmVersion: manifest.versions.npm,
    pnpmVersion: manifest.versions.pnpm,
    pythonHome: path.join(root, 'python'),
    pathDirectories: ['node', 'pnpm', 'python', 'python/Scripts', 'git/cmd', 'git/mingw64/bin', 'git/usr/bin', 'ffmpeg/bin'].map((relative) => path.join(root!, relative)),
  };
}

/** Scoped to launcher child processes; never writes the user's or machine's PATH. */
export function portableToolEnvironment(tools: PortableToolchain, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const previousPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  for (const key of Object.keys(env)) {
    if (/^(PATH|PYTHONHOME|PYTHONPATH|GIT_EXEC_PATH|GIT_SSL_CAINFO)$/i.test(key)) delete env[key];
  }
  env.PATH = [...tools.pathDirectories, previousPath].filter(Boolean).join(path.delimiter);
  // A full CPython distribution locates its own Lib next to python.exe.
  // Forcing PYTHONHOME would prevent instance-created virtual environments from working.
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONUTF8 = '1';
  env.GIT_EXEC_PATH = path.join(tools.rootPath, 'git', 'mingw64', 'libexec', 'git-core');
  env.GIT_SSL_CAINFO = tools.gitCaBundle;
  return env;
}

/** Apply the application-scoped environment before creating workers/services. */
export async function loadApplicationPortableTools(options: PortableToolOptions = {}): Promise<PortableToolchain> {
  const tools = await resolvePortableTools(options);
  const env = portableToolEnvironment(tools, process.env);
  for (const key of Object.keys(process.env)) {
    if (/^(PATH|PYTHONHOME|PYTHONPATH|GIT_EXEC_PATH|GIT_SSL_CAINFO)$/i.test(key)) delete process.env[key];
  }
  Object.assign(process.env, env);
  return tools;
}
