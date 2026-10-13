import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { safeStorage } from 'electron';
import { z } from 'zod';
import { atomicJson } from '../dsh/files';
import { companionIdSchema } from '../../shared/companions';

const keysSchema = z.record(companionIdSchema, z.string().max(24000));
/** Only encrypted per-contact keys are stored. The plaintext never crosses renderer/storage IPC. */
export class CompanionCredentials {
  private writes = Promise.resolve();
  private readonly file: string;
  constructor(root: string) { this.file = path.join(root, 'llm-keys.enc.json'); }
  private async read(): Promise<Record<string, string>> {
    await this.writes;
    return this.readUnlocked();
  }
  private async readUnlocked(): Promise<Record<string, string>> {
    try {
      const text = await readFile(this.file, 'utf8');
      if (text.length > 1024 * 1024) throw new Error('伙伴密钥文件过大。');
      return keysSchema.parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error('伙伴密钥文件无法读取，原文件已保留。', { cause: error });
    }
  }
  async has(id: string): Promise<boolean> { return !!(await this.read())[id]; }
  async ids(): Promise<Set<string>> { return new Set(Object.keys(await this.read())); }
  async get(id: string): Promise<string> {
    const encrypted = (await this.read())[id];
    if (!encrypted) throw new Error('请为此伙伴配置专属 LLM 服务的 API Key，或切换为全局配置。');
    try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
    catch { throw new Error('伙伴密钥无法解密，请在联系人设置中重新保存。'); }
  }
  save(id: string, key: string): Promise<void> {
    companionIdSchema.parse(id);
    if (key && !safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密不可用，未保存明文密钥。');
    const encrypted = key ? safeStorage.encryptString(key).toString('base64') : undefined;
    const work = this.writes.then(async () => {
      const data = await this.readUnlocked();
      if (encrypted) data[id] = encrypted; else delete data[id];
      await atomicJson(this.file, data);
    });
    this.writes = work.catch(() => undefined);
    return work;
  }
  flush(): Promise<void> { return this.writes; }
}
