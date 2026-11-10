/* global require, setTimeout, process */
/* eslint-disable @typescript-eslint/no-require-imports -- This fixed source runs in a CommonJS worker, including packaged Electron. */
// Trusted worker code. Paths arrive as data; no caller-supplied SQL is executed.
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const Database = require(workerData.nativeModule);
const { root, job } = workerData;
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const pause = () => new Promise(resolve => setTimeout(resolve, 1));
let removed = 0, lastProgress = 0, database, plan;
const progress = (phase, force = false) => {
  if (force || Date.now() - lastProgress > 150) { lastProgress = Date.now(); parentPort.postMessage({ phase, removed }); }
};
const kept = new Set(['bot_companions','bot_persona_templates','bot_persona_settings','bot_conversations','bot_members','bot_maintenance_settings']);
const metadataSetting = key => /^(companion-enabled:|conversation-participation:|group-announcement:|world:)/.test(key);
async function physicalChild(target) {
  const absolute = path.resolve(target), relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('清理路径越出伙伴资料目录。');
  let current = path.resolve(root);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw Error('伙伴清理目录包含链接，已保留清理任务等待处理。'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}
async function removePhysical(target) {
  if (!await physicalChild(target)) return;
  await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
async function clearMedia(home) {
  if(!await physicalChild(home))return;
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(home,'manifest.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;await removePhysical(home);return;}
  const stickers=(manifest.media||[]).filter(item=>item.kind==='sticker');
  if(!stickers.length){await removePhysical(home);return;}
  // Imported sticker collections are user assets, not chat history.
  const objects=new Set(stickers.flatMap(item=>[item.object,item.previewObject].filter(Boolean)));
  const temporary=path.join(home,'manifest.json.cleanup.tmp');
  await fs.writeFile(temporary,JSON.stringify({...manifest,media:stickers}));await fs.rename(temporary,path.join(home,'manifest.json'));
  try{for(const item of await fs.readdir(path.join(home,'objects'))){if(!objects.has('objects/'+item))await removePhysical(path.join(home,'objects',item));}}catch(error){if(error.code!=='ENOENT')throw error;}
}
function insert(kind, value) { if (typeof value === 'string' && value) plan.prepare(`INSERT OR IGNORE INTO ${kind}(id) VALUES(?)`).run(value); }
async function* ids(table) {
  let cursor='';
  for (;;) { const rows=plan.prepare(`SELECT id FROM ${table} WHERE id>? ORDER BY id LIMIT 500`).all(cursor); if(!rows.length)return;
    for(const row of rows)yield row; cursor=rows.at(-1).id; await pause(); }
}
function addScope(scope) {
  if (!scope || typeof scope.companionId !== 'string' || typeof scope.securityDomainId !== 'string') return;
  const home = digest([scope.companionId, scope.securityDomainId]);
  insert('domains', home);
}
function columns(db, name) { return db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(column => column.name); }
const mappings = {
  conversation_id:'rooms', source_conversation_id:'rooms', peer_conversation_id:'rooms', target_conversation_id:'rooms',
  event_id:'events', source_event_id:'events', result_event_id:'events', return_event_id:'events', causation_id:'events', authorizing_event_id:'events',
  message_id:'messages', source_record_id:'messages', reply_message_id:'messages', target_message_id:'messages',
  task_id:'tasks', proxy_task_id:'tasks', lane_id:'lanes', domain_key:'domains', owner_key:'owners',
  job_id:'jobs', brain_id:'brains', delegation_id:'delegations', workflow_id:'workflows', plan_id:'workflows',
  grant_id:'grants',
};
function predicate(db, table, all = job.all) {
  if (all) return '1';
  const fields = columns(db, table), clauses = [];
  for (const field of fields) {
    if (mappings[field]) clauses.push(`${quote(field)} IN (SELECT id FROM cleanup.${mappings[field]})`);
    if (field === 'owner_key') clauses.push(`${quote(field)} IN (SELECT id FROM cleanup.domains)`);
    if (field === 'companion_id') clauses.push(`${quote(field)}=${quoteLiteral(job.companionId)}`);
  }
  if (table === 'bot_deferred_task_notices') clauses.push("json_valid(payload_json) AND json_extract(payload_json,'$.conversationId') IN (SELECT id FROM cleanup.rooms)");
  if (table === 'bot_inbox') clauses.push('id IN (SELECT id FROM cleanup.events)');
  if (table === 'bot_messages') clauses.push('id IN (SELECT id FROM cleanup.messages)');
  if (table === 'bot_memory_jobs') clauses.push("json_valid(payload_json) AND (json_extract(payload_json,'$.sourceEventId') IN (SELECT id FROM cleanup.events) OR json_extract(payload_json,'$.prepared.requestId') IN (SELECT id FROM cleanup.events))");
  return clauses.length ? '(' + clauses.join(' OR ') + ')' : '0';
}
const quoteLiteral = value => "'" + value.replaceAll("'", "''") + "'";
async function batches(db, table, where) {
  // Tiny committed batches hold no long write lock; no message bodies cross to Main.
  // Advance by rowid so unrelated years of history are scanned at most once,
  // even on legacy tables that have no index for every ownership predicate.
  const select = db.prepare(`SELECT rowid AS cursor FROM ${quote(table)} WHERE rowid>? AND ${where} ORDER BY rowid LIMIT 200`);
  const statement = db.prepare(`DELETE FROM ${quote(table)} WHERE rowid>? AND rowid<=? AND ${where}`);
  let cursor=Number.MIN_SAFE_INTEGER;
  for (;;) {
    const rows=select.all(cursor);if(!rows.length)break;
    const next=rows.at(-1).cursor,result=statement.run(cursor,next);cursor=next;
    removed += result.changes;
    plan.prepare("INSERT OR REPLACE INTO state(key,value) VALUES('removed',?)").run(String(removed));
    progress('records'); await pause();
  }
}
async function planCleanup() {
  progress('planning', true);
  for (const name of ['rooms','messages','events','tasks','lanes','domains','owners','jobs','brains','delegations','workflows','tokens','media','files','grants']) plan.exec(`CREATE TABLE IF NOT EXISTS ${name}(id TEXT PRIMARY KEY)`);
  if (plan.prepare("SELECT value FROM state WHERE key='planned'").get()) return;
  const all = job.all, has = name => !!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (all) plan.exec('INSERT OR IGNORE INTO rooms SELECT id FROM source.bot_conversations');
  else plan.prepare('INSERT OR IGNORE INTO rooms SELECT conversation_id FROM source.bot_members WHERE member_id=?').run(job.companionId);
  for (const [kind, table] of [['messages','bot_messages'],['events','bot_inbox'],['tasks','bot_tasks'],['lanes','bot_lanes']]) {
    if (has(table)) plan.exec(`INSERT OR IGNORE INTO ${kind} SELECT id FROM source.${table} WHERE conversation_id IN (SELECT id FROM rooms)`);
  }
  // Returned results reference the actual peer publication in another room.
  // Remove only those dependent notifications/replies, not that room's other
  // conversations, credentials, personas or native DSH workspace.
  for (;;) {
    const added=plan.prepare(`INSERT OR IGNORE INTO events SELECT id FROM source.bot_inbox WHERE source_instance_id='peer-return-v1'
      AND source_record_id IN (SELECT id FROM messages)`).run().changes;
    plan.exec('INSERT OR IGNORE INTO messages SELECT reply_message_id FROM source.bot_inbox WHERE id IN (SELECT id FROM events)');
    if(!added)break;
    await pause();
  }
  for (const kind of ['messages','events','tasks','lanes','rooms']) plan.exec(`INSERT OR IGNORE INTO tokens SELECT id FROM ${kind}`);
  for (const raw of database.prepare('SELECT DISTINCT m.member_id AS companionId,c.id AS conversationId,c.domain_id AS securityDomainId FROM bot_members m JOIN bot_conversations c ON c.id=m.conversation_id WHERE m.member_id<>?').iterate('user')) {
    if (all || raw.companionId === job.companionId || plan.prepare('SELECT 1 FROM rooms WHERE id=?').get(raw.conversationId)) addScope(raw);
  }
  if (has('bot_media_grants')) plan.exec('INSERT OR IGNORE INTO grants SELECT id FROM source.bot_media_grants WHERE conversation_id IN (SELECT id FROM rooms)');
  try { for (const home of await fs.readdir(path.join(root,'memory'),{withFileTypes:true})) {
    if (!home.isDirectory() || !/^[a-f0-9]{64}$/.test(home.name)) continue;
    try { const scope=JSON.parse(await fs.readFile(path.join(root,'memory',home.name,'worldlinebox-scope.json'),'utf8'));
      if (all || scope.companionId===job.companionId || plan.prepare('SELECT 1 FROM rooms WHERE id=?').get(scope.conversationId)) addScope(scope);
    } catch(error) { if(error.code!=='ENOENT') throw error; }
  } } catch(error) { if(error.code!=='ENOENT') throw error; }
  for (const raw of database.prepare('SELECT id,domain_key,payload_json FROM bot_memory_jobs').iterate()) {
    let payload; try { payload = JSON.parse(raw.payload_json); } catch { continue; }
    const scope = payload.scope || payload.prepared?.scope;
    if (!scope || !all && scope.companionId !== job.companionId && !plan.prepare('SELECT 1 FROM rooms WHERE id=?').get(scope.conversationId)) continue;
    addScope(scope); insert('jobs', raw.id);
    if (payload.sourceEventId) {
      const version = payload.policyVersion || 1;
      const key = digest({ jobId: raw.id, scope, sourceEventId: payload.sourceEventId, ...(version === 1 ? {} : { policyVersion: version }) });
      const filename = path.join(root, 'memory-encoder','capture-plans',key + '.json'); insert('files',filename);
      try {
        const saved = JSON.parse(await fs.readFile(filename,'utf8'));
        const fragments = saved.segmented ? saved.parts.map(pieces => `capture-part-${digest({jobId:raw.id,pieces,sourceHash:saved.sourceHash})}`) : [`capture${version === 1 ? '' : '-v' + version}-${raw.id}`];
        for (const fragment of fragments) insert('files',path.join(root,'memory-encoder','capture-results',digest({jobId:raw.id,fragment,policy:version}) + '.json'));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await pause();
  }
  if (has('bot_maintenance_settings')) for (const row of database.prepare('SELECT owner_key,scope_json FROM bot_maintenance_settings').iterate()) {
    const scope = JSON.parse(row.scope_json);
    if (all || scope.companionId === job.companionId || plan.prepare('SELECT 1 FROM rooms WHERE id=?').get(scope.conversationId)) { addScope(scope); insert('owners',row.owner_key); }
  }
  for (const [kind, table] of [['jobs','bot_maintenance_jobs'],['brains','bot_brains'],['delegations','bot_delegations'],['workflows','bot_workflows']]) if (has(table)) {
    const where = predicate(database,table);
    // The retired local brain keyed its state by companion_id, not id.
    const key = columns(database,table).includes('id') ? 'id' : 'companion_id';
    plan.exec(`INSERT OR IGNORE INTO ${kind} SELECT ${key} FROM source.${quote(table)} WHERE ${where.replaceAll('cleanup.','')}`);
  }
  for await (const row of ids('rooms')) insert('media',digest(row.id));
  for (const kind of ['domains','owners','jobs','brains','delegations','workflows']) plan.exec(`INSERT OR IGNORE INTO tokens SELECT id FROM ${kind}`);
  plan.exec("INSERT OR IGNORE INTO tokens SELECT correlation_id FROM source.bot_messages WHERE id IN(SELECT id FROM messages)");
  let cursor='';
  for (;;) {
    const rows=plan.prepare('SELECT id FROM tokens WHERE id>? ORDER BY id LIMIT 1000').all(cursor); if(!rows.length)break;
    for(const row of rows)for(const match of row.id.matchAll(/[a-f0-9]{64}/g))insert('tokens',match[0]);
    cursor=rows.at(-1).id; await pause();
  }
  plan.exec("INSERT OR REPLACE INTO state(key,value) VALUES('planned','1')");
}
async function eraseMetadata() {
  const match = plan.prepare('SELECT 1 FROM tokens WHERE id=?'); let cursor = '';
  for (;;) {
    const rows = database.prepare('SELECT key,value FROM bot_metadata WHERE key>? ORDER BY key LIMIT 100').all(cursor); if (!rows.length) break;
    const ids = rows.filter(row => {
      if (metadataSetting(row.key)) return false;
      if (job.all || row.key.includes(job.companionId)) return true;
      if (row.key.startsWith('native-continue-command:') && match.get(row.value)) return true;
      const tokens = [...(row.key.match(/(?:event-|lane-|task-|reply-)?[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g) || [])];
      return tokens.some(token => match.get(token) || match.get(token.replace(/^(event-|lane-|task-|reply-)/,'')));
    });
    database.transaction(() => { for (const row of ids) removed += database.prepare('DELETE FROM bot_metadata WHERE key=?').run(row.key).changes; })();
    cursor = rows.at(-1).key; progress('records'); await pause();
  }
}
async function resetMaintenance() {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='bot_maintenance_settings'").get()) return;
  let cursor='';
  for (;;) {
    const rows=database.prepare(`SELECT owner_key,settings_json FROM bot_maintenance_settings WHERE owner_key>? AND ${predicate(database,'bot_maintenance_settings')} ORDER BY owner_key LIMIT 200`).all(cursor);
    if(!rows.length)break;
    database.transaction(()=>{for(const row of rows){
      const previous=JSON.parse(row.settings_json),now=Date.now(),next=now+(previous.intervalHours||24)*3600000;
      const settings={enabled:previous.enabled,kind:previous.kind,intervalHours:previous.intervalHours,idleMinutes:previous.idleMinutes,minNotes:previous.minNotes,autoApply:previous.autoApply,nextEligibleAt:new Date(next).toISOString(),lastActivityAt:new Date(now).toISOString()};
      database.prepare('UPDATE bot_maintenance_settings SET dirty=0,planned=0,last_activity=?,next_due=?,settings_json=? WHERE owner_key=?').run(now,next,JSON.stringify(settings),row.owner_key);
    }})();
    cursor=rows.at(-1).owner_key;await pause();
  }
}
async function main() {
  if (path.basename(path.resolve(root)) !== 'companion-bot-v2' || !path.isAbsolute(root)) throw Error('不是有效的伙伴资料目录。');
  if ((await fs.lstat(root)).isSymbolicLink()) throw Error('伙伴资料目录不能是链接。');
  await fs.mkdir(path.join(root,'data-cleanup'),{recursive:true});
  plan = new Database(path.join(root,'data-cleanup',job.id + '.plan.sqlite'));
  plan.exec('CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT)');
  removed = Number(plan.prepare("SELECT value FROM state WHERE key='removed'").get()?.value || 0);
  const file = path.join(root,'bot.sqlite');
  database = new Database(file); database.pragma('foreign_keys=OFF'); database.pragma('secure_delete=ON'); database.pragma('busy_timeout=1000');
  plan.prepare('ATTACH DATABASE ? AS source').run(file);
  database.prepare('ATTACH DATABASE ? AS cleanup').run(path.join(root,'data-cleanup',job.id + '.plan.sqlite'));
  await planCleanup();
  progress('memory',true);
  if (job.all) await removePhysical(path.join(root,'memory'));
  else for await (const row of ids('domains')) await removePhysical(path.join(root,'memory',row.id));
  progress('records',true);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bot_%'").all().map(row=>row.name);
  // Message triggers own their FTS shadow rows. Never write shadow/config tables.
  for (const table of tables) if (!kept.has(table) && table !== 'bot_metadata' && !table.startsWith('bot_message_search')) await batches(database,table,predicate(database,table));
  await eraseMetadata();
  await resetMaintenance();
  progress('attachments',true);
  if (job.all) {
    try{for(const home of await fs.readdir(path.join(root,'media','conversations'))){if(/^[a-f0-9]{64}$/.test(home))await clearMedia(path.join(root,'media','conversations',home));}}catch(error){if(error.code!=='ENOENT')throw error;}
    await removePhysical(path.join(root,'router'));
    await removePhysical(path.join(root,'memory-encoder','capture-plans'));
    await removePhysical(path.join(root,'memory-encoder','capture-results'));
  } else {
    for await (const row of ids('media')) await clearMedia(path.join(root,'media','conversations',row.id));
    for await (const row of ids('files')) await removePhysical(row.id);
  }
  database.pragma('wal_checkpoint(TRUNCATE)');
  // Free unused pages in the background; no whole-history VACUUM on Main.
  database.pragma('optimize');
  progress('completed',true); parentPort.postMessage({ complete:true, removed });
}
main().catch(error => { parentPort.postMessage({ error:error.stack || String(error) }); process.exitCode=1; }).finally(() => { database?.close(); plan?.close(); });
