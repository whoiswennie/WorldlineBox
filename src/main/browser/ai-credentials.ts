import path from 'node:path';
import { safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { atomicJson } from '../dsh/files';

export class BrowserAiCredentials {
  private key = '';
  private writes = Promise.resolve();
  private readonly file: string;
  constructor(root: string) { this.file = path.join(root, 'search-key.enc.json'); }
  async init(): Promise<void> {
    try {
      const text = await readFile(this.file, 'utf8'); if (text.length > 24000) throw Error();
      const saved = JSON.parse(text) as { version?: unknown; encrypted?: unknown };
      if (saved.version !== 1 || typeof saved.encrypted !== 'string') throw Error();
      this.key = saved.encrypted ? safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64')) : '';
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('浏览器搜索密钥无法读取，请在浏览器设置中重新保存。', { cause: error }); }
  }
  get(): string { return this.key; }
  save(key: string): Promise<void> {
    if (key && !safeStorage.isEncryptionAvailable()) return Promise.reject(Error('系统密钥加密暂不可用，未保存明文密钥。'));
    const encrypted = key ? safeStorage.encryptString(key).toString('base64') : '';
    const write = this.writes.then(async () => { await atomicJson(this.file, { version: 1, encrypted }); this.key = key; });
    this.writes = write.catch(() => undefined); return write;
  }
  flush(): Promise<void> { return this.writes; }
}
