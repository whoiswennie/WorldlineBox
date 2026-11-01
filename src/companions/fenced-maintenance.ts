import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { COMPANION_COGNITION_PROTOCOL } from './cognition-protocol';
import { assertCompanionRecoveryLedger, CompanionRecoveryFence, createCompanionRecoveryMutationRunner, fencedCompanionConnection,
  type CompanionRecoveryHead, type CompanionRecoverySelection } from './recovery-fence';
import type { CompanionConnection } from './store';

const Database = BetterSqlite3 as { new(file: string, options: { fileMustExist: true; readonly?: boolean }): CompanionConnection };
const sameHead = (a: CompanionRecoveryHead, b: CompanionRecoveryHead) => a.lineageId === b.lineageId && a.generation === b.generation;
type Stamp = { dataVersion: number; schemaVersion: number };
const stamp = (db: CompanionConnection): Stamp => ({ dataVersion: Number(db.pragma('data_version', { simple: true })), schemaVersion: Number(db.pragma('schema_version', { simple: true })) });
function existingLedger(selection: CompanionRecoverySelection): string {
  const ledger = path.join(selection.libraryPath, '.worldlinebox', 'companions', 'messages.sqlite');
  assertCompanionRecoveryLedger(selection, ledger);
  const stat = lstatSync(ledger);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || path.resolve(realpathSync(ledger)).toLowerCase() !== path.resolve(ledger).toLowerCase()) throw new Error('离线维护账本不是宿主原始普通文件。');
  return ledger;
}
function existingProtocol(db: CompanionConnection): void {
  const protocol = db.prepare('SELECT protocol FROM companion_cognition_protocol WHERE singleton=1').get() as { protocol: string } | undefined;
  if (protocol?.protocol !== COMPANION_COGNITION_PROTOCOL) throw new Error('离线维护不会创建或迁移未知认知账本。');
}

/** Planning/reentry inspection cannot settle a pending fence or write either
 * database. A pending operation requires its explicit apply/reconciliation. */
export function inspectCompanionFencedMaintenance(selection: CompanionRecoverySelection): { db: CompanionConnection; head: CompanionRecoveryHead; close(): void } {
  const ledger = existingLedger(selection), fence = new CompanionRecoveryFence(selection, ledger, undefined, { readonly: true });
  let db: CompanionConnection | undefined;
  try {
    db = new Database(ledger, { readonly: true, fileMustExist: true }); existingProtocol(db);
    const head = fence.current();
    if (!sameHead(fence.reconcile(db), head)) throw new Error('只读维护检查期间宿主水位已变化。');
    const primary = db; let closed = false;
    return { db: primary, head, close() { if (closed) return; closed = true; try { primary.close(); } finally { fence.close(); } } };
  } catch (error) { try { db?.close(); } finally { fence.close(); } throw error; }
}

export interface CompanionFencedMaintenance {
  /** A guarded connection, never the raw primary. Writes require mutate(). */
  readonly db: CompanionConnection;
  readonly head: CompanionRecoveryHead;
  /** Synchronous, all-or-nothing SQL. The fixed incident adapter owns its exact
   * manifest/CAS and durable operation receipt; this is not a revival API. */
  mutate<T>(run: (db: CompanionConnection) => T): T;
  close(): void;
}

/** Host-only offline bootstrap. The caller must stop normal workers/producers
 * first. It opens only an existing, enrolled current ledger and performs no
 * Store construction, migration, domain initialization, backfill or timers.
 * Reentry must use the head from the fixed adapter's exact durable receipt,
 * never an unreviewed replacement for that adapter's original expected head. */
export function openCompanionFencedMaintenance(selection: CompanionRecoverySelection, expectedHead: CompanionRecoveryHead): CompanionFencedMaintenance {
  if (!expectedHead.lineageId || !Number.isSafeInteger(expectedHead.generation) || expectedHead.generation < 0) throw new Error('离线维护需要准确的宿主恢复水位。');
  const ledger = existingLedger(selection);
  // Without a primary, an absent authority cannot enroll a new identity.
  const fence = new CompanionRecoveryFence(selection, ledger);
  let raw: CompanionConnection | undefined;
  try {
    raw = new Database(ledger, { fileMustExist: true });
    raw.pragma('foreign_keys=ON'); raw.pragma('synchronous=FULL'); raw.pragma('busy_timeout=5000');
    const primary = raw;
    existingProtocol(primary);
    // Reconciliation may itself settle a crashed marker. Do not put it in a
    // transaction later rolled back by an expected-head admission failure.
    fence.reconcile(primary);
    const initial = primary.transaction(() => {
      const head = fence.current();
      if (!sameHead(head, expectedHead)) throw new Error('离线维护宿主水位已变化，请重新核对原操作。');
      return { head, baseline: stamp(primary) };
    }).immediate();
    let { head, baseline } = initial;
    const runner = createCompanionRecoveryMutationRunner(primary, fence);
    let active = false, closed = false, poisoned = false;
    const assertCurrent = () => {
      if (closed || poisoned) throw new Error('离线维护连接已关闭或执行结果待核对。');
      const now = stamp(primary);
      if (now.dataVersion !== baseline.dataVersion || now.schemaVersion !== baseline.schemaVersion || !sameHead(fence.current(), head)) throw new Error('离线维护期间有外部写入或宿主水位变化。');
    };
    const guarded = fencedCompanionConnection(primary, run => {
      if (!active || closed || poisoned) throw new Error('离线维护写入必须位于明确的宿主维护事务内。');
      return runner(run);
    });
    // PRAGMA is not a statement guard in the regular Store connection. This
    // offline adapter exposes only its harmless inspection forms.
    const db: CompanionConnection = new Proxy(guarded, { get(target, key) {
      if (key === 'close') return () => { throw new Error('请关闭完整宿主维护会话。'); };
      if (key === 'pragma') return (sql: string, options?: { simple?: boolean }) => {
        if (!/^(?:data_version|schema_version|integrity_check|foreign_key_check)$/u.test(sql)) throw new Error('离线维护不接受改变连接或账本配置的 PRAGMA。');
        return target.pragma(sql, options);
      };
      return Reflect.get(target, key, target);
    } });
    return {
      db,
      get head() { assertCurrent(); return { ...head }; },
      mutate<T>(run: (connection: CompanionConnection) => T): T {
        if (active) throw new Error('离线维护不能嵌套新的宿主操作。');
        assertCurrent();
        try {
          let changed = false;
          const result = runner(() => {
            // Check after IMMEDIATE acquired the writer lock as well: another
            // connection cannot slip a commit between admission and our CAS.
            assertCurrent(); active = true;
            try {
              const before = primary.prepare('SELECT total_changes() AS changes,(SELECT schema_version FROM pragma_schema_version) AS schemaVersion').get() as { changes: number; schemaVersion: number };
              const result = run(db);
              if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) throw new Error('离线维护事务必须同步完成，不能返回异步工作。');
              const after = primary.prepare('SELECT total_changes() AS changes,(SELECT schema_version FROM pragma_schema_version) AS schemaVersion').get() as { changes: number; schemaVersion: number };
              changed = before.changes !== after.changes || before.schemaVersion !== after.schemaVersion;
              return result;
            } finally { active = false; }
          });
          const after = stamp(primary), nextHead = fence.current();
          if (after.dataVersion !== baseline.dataVersion || nextHead.lineageId !== head.lineageId || nextHead.generation !== head.generation + Number(changed)) throw new Error('离线维护提交后有未知外部写入，请核对同一操作凭据。');
          head = nextHead; baseline = after;
          return result;
        } catch (error) {
          // A failed finish may follow a committed primary transaction. Do not
          // silently retry on this handle; reopen the exact operation/receipt.
          poisoned = true; throw error;
        }
      },
      close() { if (closed) return; closed = true; try { primary.close(); } finally { fence.close(); } },
    };
  } catch (error) { try { raw?.close(); } finally { fence.close(); } throw error; }
}
