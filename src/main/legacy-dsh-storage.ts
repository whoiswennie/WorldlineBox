import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename } from './dsh/disk';
import { contained, copyTree, inventoryTree } from './dsh/files';

export interface LegacyDshMigrationResult {
  readonly status: 'migrated' | 'missing' | 'target-exists' | 'needs-backup-import' | 'source-in-use' | 'unsafe';
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly message: string;
  readonly fileCount?: number;
  readonly byteLength?: number;
}

const exists = async (file: string): Promise<boolean> => {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};

function absolute(value: string): string {
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error('Migration paths must be absolute.');
  return path.resolve(value);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Reject links on every existing ancestor, including links outside the copied tree. */
async function unlinkedPath(value: string): Promise<void> {
  const parsed = path.parse(value);
  let current = parsed.root;
  const parts = path.relative(parsed.root, value).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    if (!(await exists(current))) break;
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Migration paths cannot contain links: ${current}`);
    const physical = await realpath(current);
    const key = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
    if (key(physical) !== key(current)) throw new Error(`Migration path resolves to a different directory: ${current}`);
  }
}

async function registry(root: string, name: string): Promise<unknown[]> {
  const file = contained(root, name);
  await unlinkedPath(file);
  if (!(await exists(file))) return [];
  const info = await lstat(file);
  if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error(`Invalid legacy registry: ${name}`);
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`Invalid legacy registry: ${name}`);
  return value;
}

/**
 * Call after acquiring the target application's user-data single-instance lock.
 * Only relocate an empty-instance/empty-runtime store, preserving its verified
 * installer cache and history. Operational absolute paths need explicit backup
 * import instead. This never copies Chromium preferences or deletes the source.
 * Physical I/O comes from dsh/disk (original-fs in Electron), including ASAR bytes.
 */
export async function migrateLegacyDshStorage(options: {
  readonly projectRoot: string;
  readonly userDataPath: string;
  readonly legacyUserDataPath?: string;
  readonly sourceInUse?: boolean;
}): Promise<LegacyDshMigrationResult> {
  let sourcePath = path.join(options.legacyUserDataPath ?? path.join(options.projectRoot, '.tools', 'dev-user-data'), 'dsh-launcher');
  let targetPath = path.join(options.userDataPath, 'dsh-launcher');
  const result = (status: LegacyDshMigrationResult['status'], message: string): LegacyDshMigrationResult => ({ status, sourcePath, targetPath, message });
  try {
    const projectRoot = absolute(options.projectRoot);
    const userDataPath = absolute(options.userDataPath);
    const legacyProfile = absolute(options.legacyUserDataPath ?? path.join(projectRoot, '.tools', 'dev-user-data'));
    sourcePath = contained(legacyProfile, 'dsh-launcher');
    targetPath = contained(userDataPath, 'dsh-launcher');
    if (inside(sourcePath, targetPath) || inside(targetPath, sourcePath)) throw new Error('Source and destination DSH storage must not overlap.');
    await unlinkedPath(sourcePath);
    await unlinkedPath(targetPath);
    if (!(await exists(sourcePath))) return result('missing', 'No legacy DSH storage was found.');
    if (!(await lstat(sourcePath)).isDirectory()) throw new Error('Legacy DSH storage is not a directory.');
    if (await exists(targetPath)) return result('target-exists', 'Existing shared DSH storage was preserved; automatic merging was skipped.');
    if (options.sourceInUse) return result('source-in-use', 'Close the application using the old profile before copying its DSH storage.');
    const operations = await registry(sourcePath, 'operations/operations.json');
    if (operations.some(value => typeof value === 'object' && value !== null && 'status' in value && (value.status === 'running' || value.status === 'queued'))) {
      return result('source-in-use', 'A legacy launcher operation is still marked running or queued. Close the old application and finish or recover that operation first.');
    }
    for (const name of ['cache', 'staging']) {
      const directory = contained(sourcePath, name);
      if (!(await exists(directory))) continue;
      await unlinkedPath(directory);
      if (!(await lstat(directory)).isDirectory()) throw new Error(`Invalid legacy launcher directory: ${name}`);
      const entries = await readdir(directory);
      if (name === 'staging' && entries.length > 0 || name === 'cache' && entries.some(entry => /\.download$/i.test(entry))) {
        return result('source-in-use', 'Incomplete legacy downloads or staging files were preserved. Finish or recover the old operation before automatic copying.');
      }
    }
    for (const name of ['instances.json', 'runtimes.json', 'snapshots.json', 'packs.json']) {
      if ((await registry(sourcePath, name)).length > 0) return result('needs-backup-import', 'Legacy instances or installed environments were preserved. Export complete backups or packs from the old launcher and import them into the shared profile.');
    }
    for (const name of ['instances', 'runtimes', 'snapshots', 'packs']) {
      const directory = contained(sourcePath, name);
      if (await exists(directory)) {
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Legacy environment directory is linked or invalid: ${name}`);
        if ((await readdir(directory)).length > 0) return result('needs-backup-import', 'Unregistered legacy environment data was preserved. Recover it in the old launcher, then use backup or pack import.');
      }
    }
    // Reject links and unsupported files before copying, then recheck both sides
    // before the single directory commit to detect writes by an old process.
    const before = await inventoryTree(sourcePath);
    for (const file of before.files) {
      const expected = /^cache\/([a-f0-9]{64})\.exe$/i.exec(file.path)?.[1];
      if (expected && expected.toLowerCase() !== file.sha256) throw new Error('A cached legacy installer does not match its recorded SHA-256 filename.');
    }
    await mkdir(userDataPath, { recursive: true });
    await unlinkedPath(userDataPath);
    const staging = contained(userDataPath, `.dsh-launcher-migration-${randomUUID()}`);
    await mkdir(staging);
    await copyTree(sourcePath, staging);
    const copied = await inventoryTree(staging);
    const after = await inventoryTree(sourcePath);
    if (before.contentSha256 !== copied.contentSha256 || before.contentSha256 !== after.contentSha256) throw new Error('Legacy DSH data changed during copying; the old profile and uncommitted staging copy were preserved.');
    await unlinkedPath(targetPath);
    if (await exists(targetPath)) return result('target-exists', 'Shared DSH storage appeared while copying; it was preserved and the staging copy was not committed.');
    await rename(staging, targetPath);
    return { ...result('migrated', 'Verified legacy DSH installer cache and history were copied; the old profile was kept.'), fileCount: copied.fileCount, byteLength: copied.byteLength };
  } catch (error) {
    return result('unsafe', `Legacy DSH storage was preserved: ${error instanceof Error ? error.message : String(error)}`);
  }
}
