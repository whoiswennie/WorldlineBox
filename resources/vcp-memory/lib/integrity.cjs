'use strict';
// Process-local host attestations avoid hashing the same immutable release for
// every audience. No seal is usable without the current application's key.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function snapshotFingerprint(root, executable) {
  root = fs.realpathSync(root);
  const upstream = fs.realpathSync(path.join(root, 'upstream'));
  if (!inside(root, upstream)) throw new Error('Snapshot directory escapes its release.');
  const manifestFile = path.join(upstream, 'manifest.json');
  const manifestBytes = fs.readFileSync(manifestFile), manifest = JSON.parse(manifestBytes);
  if (!Array.isArray(manifest.files)) throw new Error('Snapshot manifest files are missing.');
  const files = [manifestFile, ...manifest.files.map(entry => {
    if (!entry || typeof entry.project !== 'string' || typeof entry.path !== 'string'
      || !entry.project || !entry.path || /[\0]/.test(entry.project + entry.path)) throw new Error('Invalid snapshot manifest path.');
    const project = path.resolve(upstream, entry.project), candidate = path.resolve(project, entry.path);
    if (!inside(upstream, project) || !inside(project, candidate)) throw new Error('Snapshot manifest path escapes its project.');
    return candidate;
  })];
  const records = files.map(file => {
    const physical = fs.realpathSync(file);
    if (!inside(upstream, physical)) throw new Error('Snapshot file escapes its release.');
    const value = fs.statSync(file, { bigint: true });
    if (!value.isFile()) throw new Error('Snapshot entry is not a regular file.');
    return [file, physical, ...['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].map(key => String(value[key]))];
  });
  const node = fs.realpathSync(executable);
  const nodeStat = fs.statSync(node, { bigint: true });
  return sha(JSON.stringify({ version: 1, root, node, nodeStat: ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(nodeStat[key])),
    manifestSha256: sha(manifestBytes), records }));
}
function unseal(seal, key, fingerprint) {
  if (typeof seal !== 'string' || seal.length > 16000 || !key) return;
  const [body, signature, extra] = seal.split('.');
  if (extra || !body || !/^[a-f0-9]{64}$/.test(signature || '')) return;
  const expected = crypto.createHmac('sha256', key).update(body).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (value.version === 1 && value.fingerprint === fingerprint && value.snapshot?.ok === true && !value.snapshot.failures?.length) return value.snapshot;
  } catch { /* Malformed or stale seals always require the original full hash check. */ }
}
function inspectSnapshot({ root, executable = process.execPath, key, seal, verify }, inspect) {
  const before = snapshotFingerprint(root, executable);
  const reused = unseal(seal, key, before);
  const snapshot = reused || verify();
  if (!snapshot || snapshot.ok !== true || snapshot.failures?.length) throw new Error('Snapshot verification did not confirm integrity.');
  const result = inspect(snapshot);
  // The local native health probe is never skipped. Changes during either the
  // hash check or the probe reject the attestation rather than sealing a race.
  const after = snapshotFingerprint(root, executable);
  if (before !== after) throw new Error('Snapshot resources changed during the integrity check. Retry after the release is stable.');
  let nextSeal;
  if (key) {
    const body = Buffer.from(JSON.stringify({ version: 1, fingerprint: after, snapshot })).toString('base64url');
    nextSeal = body + '.' + crypto.createHmac('sha256', key).update(body).digest('hex');
  }
  return { ...result, snapshotIntegrity: { reused: Boolean(reused), ...(nextSeal ? { seal: nextSeal } : {}) } };
}
module.exports = { inspectSnapshot };
