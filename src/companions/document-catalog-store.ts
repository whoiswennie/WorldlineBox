import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionDocumentCatalogCommand } from '../shared/companion-document-catalog';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';

type Row = Record<string, string | number>;
/** Rebuildable human file catalogue, never an agent memory or a source of authority. */
export class CompanionDocumentCatalogStore {
  constructor(private readonly db: CompanionConnection) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_document_catalog(id INTEGER PRIMARY KEY,companion_id TEXT NOT NULL,path TEXT NOT NULL,note_id TEXT,text TEXT NOT NULL,tags TEXT NOT NULL,generation TEXT NOT NULL,stamp TEXT NOT NULL,pending_import INTEGER NOT NULL DEFAULT 0,UNIQUE(companion_id,path));
      CREATE INDEX IF NOT EXISTS companion_document_catalog_owner ON companion_document_catalog(companion_id,path);
      CREATE INDEX IF NOT EXISTS companion_document_catalog_note ON companion_document_catalog(companion_id,note_id);
      CREATE INDEX IF NOT EXISTS companion_document_catalog_note_global ON companion_document_catalog(note_id);
      CREATE TABLE IF NOT EXISTS companion_document_folders(companion_id TEXT NOT NULL,path TEXT NOT NULL,count INTEGER NOT NULL,generation TEXT NOT NULL DEFAULT '',PRIMARY KEY(companion_id,path));
      CREATE VIRTUAL TABLE IF NOT EXISTS companion_document_search USING fts5(text,content='companion_document_catalog',content_rowid='id',tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS companion_document_search_insert AFTER INSERT ON companion_document_catalog BEGIN INSERT INTO companion_document_search(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS companion_document_search_delete AFTER DELETE ON companion_document_catalog BEGIN INSERT INTO companion_document_search(companion_document_search,rowid,text) VALUES('delete',old.id,old.text); END;
      CREATE TRIGGER IF NOT EXISTS companion_document_search_update AFTER UPDATE OF text ON companion_document_catalog BEGIN INSERT INTO companion_document_search(companion_document_search,rowid,text) VALUES('delete',old.id,old.text); INSERT INTO companion_document_search(rowid,text) VALUES(new.id,new.text); END;`);
    // Derived search rows must not retain the previous provenance envelopes.
    if ((this.db.prepare("SELECT value FROM metadata WHERE key='document-catalog-projection'").get() as { value: string } | undefined)?.value !== 'narrative-v3') {
      this.db.transaction(() => {
        this.db.exec('DELETE FROM companion_document_catalog; DELETE FROM companion_document_folders;');
        this.db.prepare("INSERT INTO metadata(key,value) VALUES('document-catalog-projection','narrative-v3') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
      }).immediate();
    }
    if (!(this.db.prepare('PRAGMA table_info(companion_document_catalog)').all() as Row[]).some(column => column.name === 'pending_import')) this.db.exec('ALTER TABLE companion_document_catalog ADD COLUMN pending_import INTEGER NOT NULL DEFAULT 0');
    const columns = this.db.prepare('PRAGMA table_info(companion_document_catalog)').all() as Row[];
    for (const name of ['created_at', 'updated_at']) if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE companion_document_catalog ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
    if (!(this.db.prepare('PRAGMA table_info(companion_document_folders)').all() as Row[]).some(column => column.name === 'generation')) this.db.exec("ALTER TABLE companion_document_folders ADD COLUMN generation TEXT NOT NULL DEFAULT ''");
    this.db.exec('CREATE INDEX IF NOT EXISTS companion_document_pending ON companion_document_catalog(companion_id,pending_import)');
    this.db.exec('CREATE INDEX IF NOT EXISTS companion_document_created ON companion_document_catalog(companion_id,created_at,path); CREATE INDEX IF NOT EXISTS companion_document_updated ON companion_document_catalog(companion_id,updated_at,path)');
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='vcp_memory_notes'").get()) this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS companion_document_withdraw AFTER UPDATE OF data ON vcp_memory_notes
      WHEN json_extract(new.data,'$.status') NOT IN('queued','indexed')
      BEGIN UPDATE companion_document_catalog SET text='',tags='[]',stamp='' WHERE note_id=new.id; END;
      CREATE TRIGGER IF NOT EXISTS companion_document_note_delete AFTER DELETE ON vcp_memory_notes
      BEGIN UPDATE companion_document_catalog SET text='',tags='[]',stamp='' WHERE note_id=old.id; END;`);
  }
  private folder(owner: string, file: string, amount: number): void {
    const parts = file.split('/'); parts.pop();
    const write = this.db.prepare('INSERT INTO companion_document_folders(companion_id,path,count) VALUES(?,?,?) ON CONFLICT(companion_id,path) DO UPDATE SET count=MAX(0,count+excluded.count)');
    while (parts.length) { write.run(owner, parts.join('/'), amount); parts.pop(); }
  }
  execute(input: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (!input.type.startsWith('document.catalog.')) return undefined;
    const command = input as CompanionDocumentCatalogCommand, owner = command.companionId;
    if (command.type === 'document.catalog.touch') {
      const updated = this.db.prepare('UPDATE companion_document_catalog SET generation=? WHERE companion_id=? AND path=? AND stamp=?').run(command.generation, owner, command.path, command.stamp);
      return { ok: true, documentCatalogUnchanged: updated.changes > 0 };
    }
    if (command.type === 'document.catalog.query') {
      const where = ['c.companion_id=?'], args: unknown[] = [owner];
      if (command.recordsOnly) where.push("c.path NOT LIKE '提示词/%' AND c.path NOT LIKE '形象/%' AND c.path NOT IN('profile.md','同步状态.md')");
      const sort = command.sort ?? 'updated_desc', dateField = command.dateField ?? 'updatedAt';
      const sortColumn = sort === 'updated_desc' ? 'updated_at' : 'created_at', ascending = sort === 'created_asc';
      const dateColumn = dateField === 'createdAt' ? 'created_at' : 'updated_at';
      const from = command.from ? new Date(command.from).toISOString() : undefined, to = command.to ? new Date(command.to).toISOString() : undefined;
      if (from && to && from > to) throw new Error('开始时间不能晚于结束时间。');
      const fingerprint = createHash('sha256').update(JSON.stringify([owner, command.directory, command.query.trim(), [...command.tags].sort(), command.noteIds ?? null, sort, dateField, from ?? null, to ?? null, !!command.recordsOnly])).digest('hex');
      if (command.directory) { where.push('c.path>=? AND c.path<?'); args.push(command.directory + '/', command.directory + '0'); }
      const tokens = command.query.trim().toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 20);
      const long = tokens.filter(token => [...token].length >= 3);
      if (long.length) { where.push('c.id IN(SELECT rowid FROM companion_document_search WHERE companion_document_search MATCH ?)'); args.push(long.map(token => '"' + token.replaceAll('"', '""') + '"').join(' AND ')); }
      for (const token of tokens.filter(token => [...token].length < 3)) { where.push('instr(lower(c.text),?)>0'); args.push(token); }
      for (const tag of command.tags) { where.push('EXISTS(SELECT 1 FROM json_each(c.tags) WHERE value=?)'); args.push(tag); }
      if (command.noteIds) { where.push('c.note_id IN(SELECT value FROM json_each(?))'); args.push(JSON.stringify(command.noteIds)); }
      if (from) { where.push(`c.${dateColumn}>=?`); args.push(from); }
      if (to) { where.push(`c.${dateColumn}<=?`); args.push(to); }
      const total = Number((this.db.prepare('SELECT COUNT(*) AS n FROM companion_document_catalog c WHERE ' + where.join(' AND ')).get(...args) as Row).n);
      if (command.cursor) {
        let cursor: { fingerprint: string; time: string; path: string };
        try {
          cursor = JSON.parse(Buffer.from(command.cursor, 'base64url').toString('utf8'));
          if (!cursor || cursor.fingerprint !== fingerprint || typeof cursor.time !== 'string' || typeof cursor.path !== 'string' || cursor.path.length > 1024) throw new Error();
        } catch { throw new Error('搜索条件或排序已经变化，请从第一页重新查询。'); }
        where.push(`(c.${sortColumn}${ascending ? '>' : '<'}? OR (c.${sortColumn}=? AND c.path>?))`); args.push(cursor.time, cursor.time, cursor.path);
      }
      const found = this.db.prepare(`SELECT c.path,c.${sortColumn} AS sort_time FROM companion_document_catalog c WHERE ` + where.join(' AND ') + ` ORDER BY c.${sortColumn} ${ascending ? 'ASC' : 'DESC'},c.path ASC LIMIT ?`).all(...args, command.limit + 1) as Row[];
      const paths = found.slice(0, command.limit).map(item => String(item.path)), hasMore = found.length > command.limit;
      const last = found[Math.min(found.length, command.limit) - 1];
      const folders = (this.db.prepare('SELECT path,count FROM companion_document_folders WHERE companion_id=? ORDER BY path').all(owner) as Row[]).map(item => ({ path: String(item.path), name: String(item.path).split('/').at(-1)!, count: Number(item.count) }));
      const pendingImport = Number((this.db.prepare('SELECT COUNT(*) AS n FROM companion_document_catalog WHERE companion_id=? AND pending_import=1').get(owner) as Row).n);
      return { ok: true, documentCatalog: { paths, folders, total, pendingImport, hasMore, ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ fingerprint, time: String(last.sort_time), path: String(last.path) })).toString('base64url') } : {}) } };
    }
    this.db.transaction(() => {
      if (command.type === 'document.catalog.put') {
        for (const folder of command.folders ?? []) this.db.prepare('INSERT INTO companion_document_folders(companion_id,path,count,generation) VALUES(?,?,0,?) ON CONFLICT(companion_id,path) DO UPDATE SET generation=excluded.generation').run(owner, folder, command.generation);
        const find = this.db.prepare('SELECT stamp FROM companion_document_catalog WHERE companion_id=? AND path=?');
        const put = this.db.prepare('INSERT INTO companion_document_catalog(companion_id,path,note_id,text,tags,generation,stamp,pending_import,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(companion_id,path) DO UPDATE SET note_id=excluded.note_id,text=excluded.text,tags=excluded.tags,generation=excluded.generation,stamp=excluded.stamp,pending_import=excluded.pending_import,created_at=excluded.created_at,updated_at=excluded.updated_at');
        for (const item of command.entries) {
          const existing = find.get(owner, item.document.path) as Row | undefined;
          if (existing?.stamp === item.stamp) { this.db.prepare('UPDATE companion_document_catalog SET generation=? WHERE companion_id=? AND path=?').run(command.generation, owner, item.document.path); continue; }
          if (!existing) this.folder(owner, item.document.path, 1);
          put.run(owner, item.document.path, item.document.noteId ?? null, item.document.title + '\n' + item.text + '\n' + item.document.tags.join(' '), JSON.stringify(item.document.tags), command.generation, item.stamp, item.document.readOnly || item.document.noteId ? 0 : 1,
            item.document.createdAt ? new Date(item.document.createdAt).toISOString() : '', new Date(item.document.updatedAt).toISOString());
        }
      } else {
        const paths = command.type === 'document.catalog.drop' ? command.paths : (this.db.prepare('SELECT path FROM companion_document_catalog WHERE companion_id=? AND generation!=?').all(owner, command.generation) as Row[]).map(item => String(item.path));
        const remove = this.db.prepare('DELETE FROM companion_document_catalog WHERE companion_id=? AND path=?');
        for (const file of paths) if (remove.run(owner, file).changes) this.folder(owner, file, -1);
        if (command.type === 'document.catalog.finish') this.db.prepare('DELETE FROM companion_document_folders WHERE companion_id=? AND count=0 AND generation!=?').run(owner, command.generation);
      }
    }).immediate();
    return { ok: true };
  }
}
