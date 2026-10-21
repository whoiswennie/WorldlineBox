import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const VCP_REPOSITORY = 'https://github.com/lioensky/VCPToolBox';
export const VCP_COMMIT = '7ceecd48c46caac8168b909ade5febbc4a254e42';
export const VCP_LICENSE = Object.freeze({ path: 'LICENSE', bytes: 14022,
  sha256: '5392a8b3f46108fa3494e8c15b57da9e14e9bbd93335590cb5b50364fcf770a8' });

const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
function validate(entry) {
  if (!entry || typeof entry.path !== 'string' || !entry.path || path.isAbsolute(entry.path)
    || entry.path.split(/[\\/]/u).some(part => !part || part === '.' || part === '..' || part.includes(':'))
    || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error('Invalid VCP restore allowlist entry.');
}
function checksum(entry, bytes) {
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Upstream checksum mismatch: ${entry.path}`);
}
async function checkedPath(destination, relative, createParents = false) {
  const root = path.resolve(destination), parts = relative.split(/[\\/]/u);
  if (createParents) await mkdir(root, { recursive: true });
  let current = root;
  for (const part of ['', ...parts.slice(0, -1)]) {
    if (part) current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!createParents) return path.join(root, ...parts);
      await mkdir(current); info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(current))) throw new Error('VCP vendor directory contains an unsafe link.');
  }
  return path.join(root, ...parts);
}

/** Fetch data only from the audited repository/commit; existing bytes are never replaced. */
export async function restoreMissingVcpFiles({ destination, entries, repository, commit, fetchFn = fetch }) {
  if (repository !== VCP_REPOSITORY || commit !== VCP_COMMIT) throw new Error('VCP restoration requires the audited repository and commit.');
  const missing = [], seen = new Set();
  for (const entry of entries) {
    validate(entry);
    if (seen.has(entry.path)) throw new Error(`Duplicate VCP restore entry: ${entry.path}`);
    seen.add(entry.path);
    const file = await checkedPath(destination, entry.path);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe VCP vendor file: ${entry.path}`);
      checksum(entry, await readFile(file));
    } catch (error) { if (error.code === 'ENOENT') missing.push(entry); else throw error; }
  }
  for (const entry of missing) {
    const url = `https://raw.githubusercontent.com/lioensky/VCPToolBox/${VCP_COMMIT}/${entry.path.split(/[\\/]/u).map(encodeURIComponent).join('/')}`;
    const response = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok || !response.body) throw new Error(`Could not restore pinned VCP file ${entry.path}: HTTP ${response.status}`);
    const parts = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > entry.bytes) throw new Error(`Pinned VCP download exceeded its allowed size: ${entry.path}`);
      parts.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(parts); checksum(entry, bytes);
    const target = await checkedPath(destination, entry.path, true), temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
      // Hard-link publication is atomic and refuses EEXIST, unlike rename() overwriting a racing writer.
      try { await link(temporary, target); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe racing VCP vendor file: ${entry.path}`, { cause: error });
        checksum(entry, await readFile(target));
      }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return missing.length;
}
