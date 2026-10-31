import { createHash } from 'node:crypto';
import { z } from 'zod';
import { companionDraftSchema } from '../shared/companions';
import { COMPANION_TEMPLATE_IDS } from '../shared/companion-template-ids';
import { companionCreationIdentitySchema, companionCreationReceiptSchema, type CompanionCreationReceipt } from '../shared/companion-creation';
import type { CompanionConnection } from './store';

export const companionCreationPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('custom'), companion: companionDraftSchema.strict() }),
  z.strictObject({ kind: z.literal('builtin'), templateId: z.enum(COMPANION_TEMPLATE_IDS) }),
]);
export type CompanionCreationPayload = z.infer<typeof companionCreationPayloadSchema>;
const prepareSchema = companionCreationIdentitySchema.extend({ request: companionCreationPayloadSchema }).strict();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}

/** Owns only durable operation identity. The host must validate published origin
 * files before commit and keep prepared identities unavailable to ordinary work. */
export class CompanionCreationStore {
  constructor(private readonly db: CompanionConnection) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_creation_operations(
      operation_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,data TEXT NOT NULL);`);
  }
  read(operationId: string): CompanionCreationReceipt | undefined {
    const id = z.uuid().parse(operationId), found = this.db.prepare('SELECT data FROM companion_creation_operations WHERE operation_id=?').get(id) as { data: string } | undefined;
    return found ? companionCreationReceiptSchema.parse(JSON.parse(found.data)) : undefined;
  }
  prepare(input: z.input<typeof prepareSchema>): CompanionCreationReceipt {
    const value = prepareSchema.parse(input), requestHash = createHash('sha256').update(canonical(value.request)).digest('hex');
    return this.db.transaction(() => {
      const previous = this.read(value.operationId);
      if (previous) {
        if (previous.companionId !== value.companionId || previous.requestHash !== requestHash) throw new Error('创建操作已绑定其他身份或角色起点，不能修改后重试。');
        if (previous.state === 'committed' || previous.state === 'prepared') return previous;
        const resumed = { ...previous, state: 'prepared' as const, updatedAt: new Date().toISOString() }; delete resumed.error; this.save(resumed); return resumed;
      }
      if (this.db.prepare('SELECT 1 FROM companion_creation_operations WHERE companion_id=?').get(value.companionId)
        || this.db.prepare('SELECT 1 FROM companions WHERE id=?').get(value.companionId)) throw new Error('这个伙伴身份已经使用，必须创建新的身份。');
      const now = new Date().toISOString();
      const receipt: CompanionCreationReceipt = { schema: 'companion-creation-v1', operationId: value.operationId, companionId: value.companionId, requestHash, state: 'prepared', createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO companion_creation_operations(operation_id,companion_id,request_hash,data) VALUES(?,?,?,?)').run(value.operationId, value.companionId, requestHash, JSON.stringify(receipt));
      return receipt;
    }).immediate();
  }
  commit(operationId: string): CompanionCreationReceipt {
    return this.db.transaction(() => {
      const previous = this.require(operationId);
      if (previous.state === 'committed') return previous;
      if (previous.state !== 'prepared') throw new Error('创建操作尚未重新准备，不能提交失败的操作。');
      if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(previous.companionId)) throw new Error('创建身份尚未持久化，不能提交。');
      const committed = { ...previous, state: 'committed' as const, updatedAt: new Date().toISOString() }; this.save(committed); return committed;
    }).immediate();
  }
  /** Host-only recovery of the already frozen SQL draft, after checking its
   * publication. No caller supplied replacement profile is accepted here. */
  resume(operationId: string): CompanionCreationReceipt {
    return this.db.transaction(() => {
      const previous = this.require(operationId);
      if (previous.state !== 'failed') return previous;
      const resumed = { ...previous, state: 'prepared' as const, updatedAt: new Date().toISOString() }; delete resumed.error; this.save(resumed); return resumed;
    }).immediate();
  }
  fail(operationId: string, error: string): CompanionCreationReceipt {
    return this.db.transaction(() => {
      const previous = this.require(operationId);
      if (previous.state === 'committed') return previous;
      const failed = { ...previous, state: 'failed' as const, updatedAt: new Date().toISOString(), error: error.slice(0, 1000) }; this.save(failed); return failed;
    }).immediate();
  }
  private require(id: string): CompanionCreationReceipt { const receipt = this.read(id); if (!receipt) throw new Error('创建操作不存在。'); return receipt; }
  private save(receipt: CompanionCreationReceipt): void {
    this.db.prepare('UPDATE companion_creation_operations SET data=? WHERE operation_id=?').run(JSON.stringify(companionCreationReceiptSchema.parse(receipt)), receipt.operationId);
  }
}
