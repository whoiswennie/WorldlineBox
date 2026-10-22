import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';

/** An already selected attachment is read in place; repeated learning never recopies its bytes. */
export async function readGoalTextFile(file: string, signal: AbortSignal): Promise<{ content: string; revision: string }> {
  signal.throwIfAborted();
  const resolved = await realpath(file), info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2097152n) throw new Error('学习文件须为不超过 2 MiB 的普通文本，可拆分后继续。');
  const handle = await open(resolved, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    const same = (left: typeof before, right: typeof before) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
    if (!same(info, before)) throw new Error('学习文件在打开前已经变化。');
    const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < buffer.length) { signal.throwIfAborted(); const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat({ bigint: true }), current = await lstat(resolved, { bigint: true });
    if (length !== Number(before.size) || !same(before, after) || !same(before, current) || current.isSymbolicLink()) throw new Error('学习文件在读取时发生变化，本轮未收录。');
    const bytes = buffer.subarray(0, length), encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
    const content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    for (let index = 0; index < content.length; index++) { const code = content.charCodeAt(index); if (code === 127 || code < 32 && code !== 9 && code !== 10 && code !== 13) throw new Error('学习文件包含二进制内容，不能作为纯文本读取。'); }
    signal.throwIfAborted(); return { content, revision: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}
