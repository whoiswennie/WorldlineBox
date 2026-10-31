import type { CompanionConnection } from './store';

export const COMPANION_COGNITION_PROTOCOL = 'worldlinebox.companion-cognition-v2';

/** A protocol boundary, not a migration. Old databases must be explicitly
 * cleared while their writer is stopped before this owner can open them. */
export function requireCompanionCognitionProtocol(db: CompanionConnection): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  if (tables.length) {
    if (!tables.some(table => table.name === 'companion_cognition_protocol'))
      throw new Error('检测到旧版伙伴账本。新认知系统不迁移或兼容读取旧数据，请先完成受管伙伴数据清理。');
    const protocol = db.prepare('SELECT protocol FROM companion_cognition_protocol WHERE singleton=1').get() as { protocol: string } | undefined;
    if (protocol?.protocol !== COMPANION_COGNITION_PROTOCOL)
      throw new Error('伙伴认知账本协议不受支持，未执行转换或恢复。');
    return;
  }
  db.transaction(() => {
    db.exec('CREATE TABLE companion_cognition_protocol(singleton INTEGER PRIMARY KEY CHECK(singleton=1),protocol TEXT NOT NULL)');
    db.prepare('INSERT INTO companion_cognition_protocol(singleton,protocol) VALUES(1,?)').run(COMPANION_COGNITION_PROTOCOL);
  }).immediate();
}
