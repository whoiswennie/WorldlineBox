/* global require, module */
'use strict';

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const fingerprintNote = note => createHash('sha256').update(JSON.stringify(note)).digest('hex');
const contentHash = text => createHash('sha256').update(text).digest('hex');
const failure = message => Object.assign(new Error(message), { code: 'VCP_MEMORY_RECORD_CHANGED' });

/** Map-shaped provenance directory, with no full text or arbitrary metadata in
 * its entries. Full owned JSON records are read only on demand. The body cache
 * accounts for both UTF-8 transport bytes and conservative UTF-16 string space;
 * its budget is independent of corpus length and is not an RSS guarantee. */
class OwnedMemoryRecordCatalog {
  constructor({ recordPath, normalize, maxCachedRecords = 16, maxCacheBytes = 2 * 1024 * 1024 }) {
    if (typeof recordPath !== 'function' || typeof normalize !== 'function'
      || !Number.isSafeInteger(maxCachedRecords) || maxCachedRecords < 0 || !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0)
      throw new TypeError('Invalid owned record catalog configuration.');
    this.recordPath = recordPath; this.normalize = normalize;
    this.maxCachedRecords = maxCachedRecords; this.maxCacheBytes = maxCacheBytes;
    this.directory = new Map(); this.bodies = new Map(); this.cacheBytes = 0;
  }
  get size() { return this.directory.size; }
  get(id) { return this.directory.get(id); }
  has(id) { return this.directory.has(id); }
  keys() { return this.directory.keys(); }
  values() { return this.directory.values(); }
  entries() { return this.directory.entries(); }
  [Symbol.iterator]() { return this.entries(); }
  forgetBody(id) {
    const previous = this.bodies.get(id);
    if (previous) { this.cacheBytes -= previous.bytes; this.bodies.delete(id); }
  }
  cacheBody(id, serialized) {
    this.forgetBody(id);
    const bytes = Buffer.byteLength(serialized, 'utf8') + serialized.length * 2 + id.length * 2 + 256;
    if (!this.maxCachedRecords || bytes > this.maxCacheBytes) return;
    while (this.bodies.size >= this.maxCachedRecords || this.cacheBytes + bytes > this.maxCacheBytes)
      this.forgetBody(this.bodies.keys().next().value);
    this.bodies.set(id, { serialized, bytes }); this.cacheBytes += bytes;
  }
  set(id, record) {
    if (record?.id !== id) throw failure('Owned record identity does not match its catalog key.');
    const note = this.normalize(record), owner = record.metadata?.hostMemoryOwner;
    const hostMemoryOwner = owner && typeof owner === 'object' ? Object.fromEntries(['version', 'companionId', 'name', 'agentName']
      .filter(key => typeof owner[key] === 'string' || typeof owner[key] === 'number').map(key => [key, owner[key]])) : undefined;
    this.directory.set(id, { id, indexState: record.indexState, deleted: record.deleted === true,
      rawPath: record.rawPath, recordedAt: record.recordedAt, diaryName: note.diaryName,
      ...(note.hostProjection ? { hostProjection: { ...note.hostProjection } } : {}),
      metadata: { ...(hostMemoryOwner ? { hostMemoryOwner } : {}),
        ...(typeof record.metadata?.hostMemoryVersion === 'number' ? { hostMemoryVersion: record.metadata.hostMemoryVersion } : {}),
        ...(record.metadata?.dream ? { dream: true } : {}) },
      noteFingerprint: fingerprintNote(note), contentHash: contentHash(note.content), contentBytes: Buffer.byteLength(note.content, 'utf8') });
    this.cacheBody(id, JSON.stringify(record));
    return this;
  }
  delete(id) { this.forgetBody(id); return this.directory.delete(id); }
  clear() { this.directory.clear(); this.bodies.clear(); this.cacheBytes = 0; }
  async read(id) {
    const descriptor = this.directory.get(id);
    if (!descriptor || descriptor.deleted || descriptor.indexState !== 'indexed') return null;
    const cached = this.bodies.get(id);
    if (cached) {
      this.bodies.delete(id); this.bodies.set(id, cached);
      return JSON.parse(cached.serialized);
    }
    let serialized;
    try { serialized = await fs.readFile(this.recordPath(id), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const record = JSON.parse(serialized);
    if (record?.id !== id || record.indexState !== 'indexed' || record.deleted
      || fingerprintNote(this.normalize(record)) !== descriptor.noteFingerprint)
      throw failure('Owned record content or provenance changed outside its catalog transaction.');
    this.cacheBody(id, serialized);
    return record;
  }
  cacheSnapshot() {
    return { records: this.directory.size, entries: this.bodies.size, bytes: this.cacheBytes,
      maxEntries: this.maxCachedRecords, maxBytes: this.maxCacheBytes };
  }
}

module.exports = { OwnedMemoryRecordCatalog, fingerprintNote };
