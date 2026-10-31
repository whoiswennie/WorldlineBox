import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { CompanionConnection } from './store';

export interface CompanionRecoverySelection { libraryPath: string; libraryId: string }
export interface CompanionRecoveryHead { lineageId: string; generation: number }
export interface CompanionRecoveryTicket extends CompanionRecoveryHead { id: string; ledgerHash: string; manifestHash: string }
export interface CompanionRestoreReceipt { id: string; ticketId: string; manifestHash: string; generation: number; state: 'preparing' | 'ready'; ledgerHash?: string; createdAt: string }
interface HeadRow { library_id: string; lineage_id: string; generation: number; pending: number; previous_generation: number; ledger_device: string; ledger_inode: string }
interface Marker { lineage_id: string; generation: number }
const Database = BetterSqlite3 as { new(file: string, options?: { readonly?: boolean; fileMustExist?: boolean }): CompanionConnection };
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const digest = (value: string) => /^[a-f0-9]{64}$/u.test(value);
function regular(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !same(realpathSync(file), file)) throw new Error('恢复权威文件被替换或包含链接。');
  return stat;
}
export function companionRecoveryFencePath(selection: CompanionRecoverySelection): string {
  if (!path.isAbsolute(selection.libraryPath) || !selection.libraryId) throw new Error('恢复必须指定宿主选定的资产库。');
  return path.join(selection.libraryPath, '.worldlinebox', 'companions-recovery-authority.sqlite');
}
function enrollmentPath(selection:CompanionRecoverySelection):string{return path.join(selection.libraryPath,'.worldlinebox','companions-recovery-enrollment.json');}
export function assertCompanionRecoveryLedger(selection: CompanionRecoverySelection, ledger: string): void {
  if (!same(ledger, path.join(selection.libraryPath, '.worldlinebox', 'companions', 'messages.sqlite'))) throw new Error('恢复账本不属于宿主选定的伙伴运行空间。');
  if (!existsSync(ledger) && (existsSync(companionRecoveryFencePath(selection))||existsSync(enrollmentPath(selection)))) throw new Error('伙伴账本已丢失；必须通过有当前宿主权威的新协议备份恢复，不能自动创建替代账本。');
}

/** Every existing store receives this same connection. Native transaction and
 * statement boundaries therefore cover background reset/index helpers and
 * host methods as well as the public request dispatcher. */
export function fencedCompanionConnection(raw: CompanionConnection, guard: <T>(run: () => T) => T): CompanionConnection {
  const connection: CompanionConnection = new Proxy(raw, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      const wrapped: typeof statement = new Proxy(statement, { get(current, member) {
        const method = Reflect.get(current, member, current);
        if (typeof method !== 'function') return method;
        return (...args: unknown[]) => {
          if (member === 'iterate' && Reflect.get(current, 'readonly') !== true) throw new Error('恢复权威不允许延迟迭代写入语句。');
          const invoke = () => { const result: unknown = Reflect.apply(method, current, args); return result === current ? wrapped : result; };
          return member === 'run' || (member === 'get' || member === 'all') && Reflect.get(current, 'readonly') !== true ? guard(invoke) : invoke();
        };
      } }); return wrapped;
    };
    if (key === 'transaction') return (run: () => unknown) => {
      const transaction = target.transaction(run);
      const wrapped = () => guard(() => transaction());
      return Object.assign(wrapped, { immediate: () => guard(() => transaction.immediate()) });
    };
    if (key === 'exec') return (sql: string) => guard(() => { target.exec(sql); return connection; });
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => { const result: unknown = Reflect.apply(value, target, args); return result === target ? connection : result; };
  } });
  return connection;
}

/** This small host database is deliberately outside the rollback payload.
 * One connection lives with the worker; writes touch one indexed row, never
 * hash the entire ledger or reopen an authority connection per message. */
export class CompanionRecoveryFence {
  private readonly db: CompanionConnection;
  private readonly identity: { device: number; inode: number };
  readonly file: string;
  constructor(readonly selection: CompanionRecoverySelection, readonly ledger: string, primary?: CompanionConnection, options:{readonly?:boolean}={}) {
    if (!same(ledger, path.join(selection.libraryPath, '.worldlinebox', 'companions', 'messages.sqlite'))) throw new Error('恢复权威与账本范围不一致。');
    for (const directory of [selection.libraryPath, path.join(selection.libraryPath, '.worldlinebox'), path.dirname(ledger)]) {
      const info = lstatSync(directory); if (!info.isDirectory() || info.isSymbolicLink() || !same(realpathSync(directory), directory)) throw new Error('恢复根目录无效或越过链接。');
    }
    const libraryFile = path.join(selection.libraryPath, '.worldlinebox', 'library.db'); regular(libraryFile);
    const library = new Database(libraryFile, { readonly: true, fileMustExist: true });
    try { const ids = library.prepare('SELECT library_id FROM library LIMIT 2').all() as Array<{ library_id: string }>;
      if (ids.length !== 1 || ids[0]?.library_id !== selection.libraryId) throw new Error('恢复权威不属于当前资产库身份。');
    } finally { library.close(); }
    this.file = companionRecoveryFencePath(selection);
    const existing = existsSync(this.file);
    if (existing) regular(this.file);
    if (!existing) {
      if (!primary || this.marker(primary) || existsSync(enrollmentPath(selection))) throw new Error('恢复权威已丢失，不能依据备份或原账本自动重建。');
      for (const table of ['companions', 'messages']) if (primary.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
        && (primary.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n) throw new Error('非空运行库不能自动建立新的恢复权威。');
    }
    this.db = new Database(this.file, { fileMustExist: existing, readonly:!!options.readonly });
    try {
      if(!options.readonly){this.db.pragma('journal_mode=WAL'); this.db.pragma('synchronous=FULL');} this.db.pragma('busy_timeout=5000');
      if (!existing) {
        const stat = regular(ledger), lineage = randomUUID();
        this.db.exec(`CREATE TABLE recovery_authority(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol TEXT NOT NULL,library_id TEXT NOT NULL,lineage_id TEXT NOT NULL,
          generation INTEGER NOT NULL,pending INTEGER NOT NULL,previous_generation INTEGER NOT NULL,ledger_device TEXT NOT NULL,ledger_inode TEXT NOT NULL);
          CREATE TABLE recovery_tickets(id TEXT PRIMARY KEY,lineage_id TEXT NOT NULL,generation INTEGER NOT NULL,ledger_hash TEXT NOT NULL,manifest_hash TEXT NOT NULL,created_at TEXT NOT NULL);
          CREATE TABLE recovery_restores(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL,manifest_hash TEXT NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL,ledger_hash TEXT,created_at TEXT NOT NULL);
          CREATE INDEX recovery_ticket_generation ON recovery_tickets(generation,id);`);
        this.db.prepare("INSERT INTO recovery_authority VALUES(1,'worldlinebox.companion-recovery-authority-v1',?,?,0,0,0,?,?)").run(selection.libraryId, lineage, String(stat.dev), String(stat.ino));
        primary!.exec('CREATE TABLE companion_recovery_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),lineage_id TEXT NOT NULL,generation INTEGER NOT NULL)');
        primary!.prepare('INSERT INTO companion_recovery_state VALUES(1,?,0)').run(lineage);
        const fd=openSync(enrollmentPath(selection),'wx',0o600);try{writeSync(fd,JSON.stringify({protocol:'worldlinebox.companion-recovery-enrollment-v1',libraryId:selection.libraryId,lineageId:lineage})+'\n');fsyncSync(fd);}finally{closeSync(fd);}
      }
      const row = this.row();
      if (row.library_id !== selection.libraryId || !integer(row.generation) || !integer(row.previous_generation)) throw new Error('恢复权威协议或资产库身份不匹配。');
      const enrollmentFile=enrollmentPath(selection);if(!existsSync(enrollmentFile))throw new Error('恢复权威登记已丢失，不会自动重建。');if(regular(enrollmentFile).size>4096)throw new Error('恢复权威登记不合法。');
      const enrollment=JSON.parse(readFileSync(enrollmentFile,'utf8')) as {protocol?:string;libraryId?:string;lineageId?:string};
      if(enrollment.protocol!=='worldlinebox.companion-recovery-enrollment-v1'||enrollment.libraryId!==selection.libraryId||enrollment.lineageId!==row.lineage_id)throw new Error('恢复权威登记缺失或身份不一致。');
      const file = regular(this.file); this.identity = { device: file.dev, inode: file.ino };
      if (primary) this.reconcile(primary);
    } catch (error) { this.db.close(); throw error; }
  }
  private assertFile(): void {
    const file = regular(this.file); if (file.dev !== this.identity.device || file.ino !== this.identity.inode) throw new Error('正在使用的恢复权威文件已被替换。');
  }
  private row(): HeadRow {
    const row = this.db.prepare("SELECT library_id,lineage_id,generation,pending,previous_generation,ledger_device,ledger_inode FROM recovery_authority WHERE singleton=1 AND protocol='worldlinebox.companion-recovery-authority-v1'").get() as HeadRow | undefined;
    if (!row) throw new Error('恢复权威缺失或协议不受支持。'); return row;
  }
  marker(primary: CompanionConnection): Marker | undefined {
    if (!primary.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_recovery_state'").get()) return;
    return primary.prepare('SELECT lineage_id,generation FROM companion_recovery_state WHERE singleton=1').get() as Marker | undefined;
  }
  reconcile(primary: CompanionConnection): CompanionRecoveryHead {
    this.assertFile(); const row = this.row(), marker = this.marker(primary), stat = regular(this.ledger);
    if (!marker || marker.lineage_id !== row.lineage_id || String(stat.dev) !== row.ledger_device || String(stat.ino) !== row.ledger_inode) throw new Error('账本不是当前宿主登记的实例；不得绕过正式恢复。');
    if (row.pending === 2) throw new Error('正式恢复尚未完成；请以同一个恢复操作继续，不能启动普通执行。');
    if (row.pending === 1) {
      if (![row.previous_generation, row.generation].includes(marker.generation)) throw new Error('未结恢复水位与账本不一致。');
      // A crashed primary transaction may have rolled back. Advancing only
      // its opaque marker keeps all pre-crash packages stale; no body is read
      // from SQLite or restored, and no revocation is reverted.
      if (marker.generation === row.previous_generation) primary.transaction(() => {
        primary.prepare('UPDATE companion_recovery_state SET generation=? WHERE singleton=1 AND generation=?').run(row.generation, row.previous_generation);
      }).immediate();
      this.finish(row.generation);
    } else if (marker.generation !== row.generation) throw new Error('检测到较早或未知账本，不能回滚当前撤销和人格权威。');
    return { lineageId: row.lineage_id, generation: row.generation };
  }
  prepare(primary: CompanionConnection): number {
    this.assertFile(); const row = this.row(), marker = this.marker(primary);
    if (row.pending || !marker || marker.lineage_id !== row.lineage_id || marker.generation !== row.generation || row.generation >= Number.MAX_SAFE_INTEGER - 1) throw new Error('恢复权威尚未结清或水位不一致。');
    const next = row.generation + 1;
    const changed = this.db.prepare('UPDATE recovery_authority SET previous_generation=generation,generation=?,pending=1 WHERE singleton=1 AND generation=? AND pending=0').run(next, row.generation);
    if (changed.changes !== 1) throw new Error('恢复权威在提交前已变化。');
    primary.prepare('UPDATE companion_recovery_state SET generation=? WHERE singleton=1 AND generation=?').run(next, row.generation);
    return next;
  }
  finish(generation: number): void { this.assertFile(); if (this.db.prepare('UPDATE recovery_authority SET pending=0 WHERE singleton=1 AND generation=? AND pending=1').run(generation).changes !== 1) throw new Error('恢复权威提交凭据未能结清。'); }
  current(): CompanionRecoveryHead { this.assertFile(); const row = this.row(); if (row.pending) throw new Error('有未结写入，不能备份或恢复。'); return { lineageId: row.lineage_id, generation: row.generation }; }
  recordTicket(ticket: CompanionRecoveryTicket): void {
    const current = this.current(); if (current.lineageId !== ticket.lineageId || current.generation !== ticket.generation || !digest(ticket.ledgerHash) || !digest(ticket.manifestHash)) throw new Error('备份期间有新写入，不能发布旧快照。');
    const existing = this.db.prepare('SELECT lineage_id,generation,ledger_hash,manifest_hash FROM recovery_tickets WHERE id=?').get(ticket.id) as {lineage_id:string;generation:number;ledger_hash:string;manifest_hash:string}|undefined;
    if (existing) { if (existing.lineage_id !== ticket.lineageId || existing.generation !== ticket.generation || existing.ledger_hash !== ticket.ledgerHash || existing.manifest_hash !== ticket.manifestHash) throw new Error('备份操作标识已经用于另一份快照。'); return; }
    this.db.prepare('INSERT INTO recovery_tickets VALUES(?,?,?,?,?,?)').run(ticket.id, ticket.lineageId, ticket.generation, ticket.ledgerHash, ticket.manifestHash, new Date().toISOString());
  }
  ticket(id: string): CompanionRecoveryTicket {
    const current = this.current(), row = this.db.prepare('SELECT id,lineage_id,generation,ledger_hash,manifest_hash FROM recovery_tickets WHERE id=?').get(id) as { id: string; lineage_id: string; generation: number; ledger_hash: string; manifest_hash: string } | undefined;
    if (!row || row.lineage_id !== current.lineageId || row.generation !== current.generation) throw new Error('备份已过期或没有当前宿主凭据；撤销、退役或后续写入不会被旧包覆盖。');
    return { id: row.id, lineageId: row.lineage_id, generation: row.generation, ledgerHash: row.ledger_hash, manifestHash: row.manifest_hash };
  }
  inspectTicket(id:string):{ticket:CompanionRecoveryTicket;current:boolean}{
    this.assertFile();const head=this.row(),row=this.db.prepare('SELECT id,lineage_id,generation,ledger_hash,manifest_hash FROM recovery_tickets WHERE id=?').get(id) as {id:string;lineage_id:string;generation:number;ledger_hash:string;manifest_hash:string}|undefined;
    if(!row||row.lineage_id!==head.lineage_id)throw new Error('备份缺少当前宿主登记的恢复凭据。');
    return{ticket:{id:row.id,lineageId:row.lineage_id,generation:row.generation,ledgerHash:row.ledger_hash,manifestHash:row.manifest_hash},current:head.pending===0&&row.generation===head.generation};
  }
  restoreReceipt(id: string): CompanionRestoreReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM recovery_restores WHERE id=?').get(id) as {id:string;ticket_id:string;manifest_hash:string;generation:number;state:'preparing'|'ready';ledger_hash?:string;created_at:string}|undefined;
    return row && { id:row.id,ticketId:row.ticket_id,manifestHash:row.manifest_hash,generation:row.generation,state:row.state,ledgerHash:row.ledger_hash ?? undefined,createdAt:row.created_at };
  }
  beginRestore(id: string, ticket: CompanionRecoveryTicket): CompanionRestoreReceipt {
    this.assertFile(); const prior=this.restoreReceipt(id);
    if (prior) { if (prior.ticketId!==ticket.id || prior.manifestHash!==ticket.manifestHash) throw new Error('恢复标识已经绑定不同的备份。'); return prior; }
    const trusted=this.ticket(ticket.id); if (JSON.stringify(trusted)!==JSON.stringify(ticket)) throw new Error('备份凭据与宿主登记不一致。');
    return this.db.transaction(()=>{
      const head=this.row(),next=head.generation+1; if(!integer(next)||head.pending) throw new Error('恢复权威尚未结清。');
      if(this.db.prepare('UPDATE recovery_authority SET previous_generation=generation,generation=?,pending=2 WHERE singleton=1 AND generation=? AND pending=0').run(next,head.generation).changes!==1) throw new Error('恢复权威已变化。');
      const at=new Date().toISOString();this.db.prepare("INSERT INTO recovery_restores(id,ticket_id,manifest_hash,state,generation,created_at) VALUES(?,?,?,'preparing',?,?)").run(id,ticket.id,ticket.manifestHash,next,at);
      return this.restoreReceipt(id)!;
    }).immediate();
  }
  stageRestore(id:string,ledgerHash:string):void {
    this.assertFile(); const receipt=this.restoreReceipt(id),head=this.row();
    if(!receipt||receipt.state!=='preparing'||head.pending!==2||head.generation!==receipt.generation||!digest(ledgerHash)||receipt.ledgerHash&&receipt.ledgerHash!==ledgerHash) throw new Error('恢复暂存正文与宿主操作不一致。');
    this.db.prepare('UPDATE recovery_restores SET ledger_hash=? WHERE id=?').run(ledgerHash,id);
  }
  finishRestore(id:string,ledgerHash:string,primary:CompanionConnection):CompanionRecoveryHead {
    this.assertFile();const receipt=this.restoreReceipt(id),head=this.row(),marker=this.marker(primary),stat=regular(this.ledger);
    if(!receipt||receipt.ledgerHash!==ledgerHash||marker?.lineage_id!==head.lineage_id||marker?.generation!==receipt.generation||head.generation!==receipt.generation) throw new Error('恢复后的账本或宿主水位不一致。');
    if(receipt.state==='ready') { this.reconcile(primary);return this.current(); }
    if(head.pending!==2) throw new Error('恢复操作没有当前宿主准备凭据。');
    this.db.transaction(()=>{this.db.prepare('UPDATE recovery_authority SET pending=0,ledger_device=?,ledger_inode=? WHERE singleton=1 AND generation=? AND pending=2').run(String(stat.dev),String(stat.ino),receipt.generation);
      this.db.prepare("UPDATE recovery_restores SET state='ready' WHERE id=?").run(id);}).immediate();
    return this.current();
  }
  close(): void { this.db.close(); }
}
