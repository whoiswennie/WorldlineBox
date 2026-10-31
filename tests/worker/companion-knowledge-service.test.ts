import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { createServer } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionKnowledgeService } from '../../src/main/companions/knowledge-service';
import { ColdKnowledgeService } from '../../src/main/vcp-memory/cold-service';
import type { CompanionMemoryRuntime } from '../../src/main/companions/vcp-runtime';
import type { VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import { LibraryService } from '../../src/worker/library-service';
import { companionLearningAssets } from '../../src/main/companions/learning-assets';
import type { WorkerCommand } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
function launch(file: string): VcpMemoryTransport {
  const child = fork(file, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr?.resume();
  return { postMessage: value => { child.send(value as object); }, on: child.on.bind(child), kill: () => { child.kill(); } };
}
it('uses actual owner sources/full memory bodies, enforces sequence/source filters before native search, and withdraws forgotten sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-knowledge-bridge-'));
  const store = new CompanionsStore(path.join(root, 'companions.db'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '认真', model: '', avatar: 'sister', proactive: false, active: true })));
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const inputs: string[] = []; let blocked = false;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { input: string[] }; inputs.push(...body.input);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1,0,0,0] })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
  let cold: ColdKnowledgeService | undefined;
  const runtime: CompanionMemoryRuntime = { get: async () => { throw Error('No hot model needed.'); }, close: async () => { await cold?.close(); },
    getCold: async (_scope, authorize) => cold ??= new ColdKnowledgeService({ dataRoot: path.join(root,'cold'), vendorRoot: path.resolve('vendor/vcp-memory'), workerPath: path.resolve('src/main/vcp-memory/cold-worker.cjs'),
      embedding: { baseUrl: `http://127.0.0.1:${port}`, model: 'fixture', modelSignature: 'fixture-space', apiKey: 'synthetic', dimension: 4 }, authorize, launch }) };
  const bridge = new CompanionKnowledgeService({ request: async command => store.request(command), runtime, blocked: () => blocked });
  try {
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'AUTHORITATIVE_FULL_BODY_CANARY\n' + 'Actual material sentence.\n'.repeat(1400) });
    const note = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'knowledge', content: source.content, tags: ['资料'], diaryName: 'SHORT_TITLE_ONLY', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: 'AUTHORITATIVE_FULL_BODY_CANARY' }] } }).memories![0]!;
    const episode = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory', content: '这次讨论中提到了这份资料，记录的是一次讨论经历。', diaryName: '资料',
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: 'AUTHORITATIVE_FULL_BODY_CANARY' }] } }).memories![0]!;
    const beforeDenied = inputs.length;
    await expect(bridge.execute({ type: 'memory.knowledge', ...scope, operation: 'ingest', sourceType: 'memory', sourceId: episode.id })).rejects.toThrow('不是知识或方法');
    expect(inputs).toHaveLength(beforeDenied);
    await expect(bridge.execute({ type: 'memory.knowledge', ...scope, operation: 'ingest', sourceType: 'memory', sourceId: note.id, text: 'forged' } as never)).rejects.toThrow();
    const receipt = await bridge.execute({ type: 'memory.knowledge', ...scope, operation: 'ingest', sourceType: 'memory', sourceId: note.id });
    expect(receipt.indexed).toBe(true); expect(receipt.result?.sourceVersion).toBe(String(note.version));
    const read = await bridge.execute({ type: 'memory.knowledge', ...scope, operation: 'read', id: receipt.result!.id, version: receipt.result!.version });
    expect(read.result?.text).toBe(note.content); expect(read.result?.metadata?.sources).toEqual(note.sources);
    store.request({ type: 'memory.organize', ...scope, ids: [note.id], tags: ['更新后的标签'] });
    const annotated = await bridge.execute({ type: 'memory.knowledge', ...scope, operation: 'read', id: receipt.result!.id, version: receipt.result!.version });
    expect(annotated.result?.text).toBe(note.content); expect(annotated.result?.sourceVersion).toBe(String(note.contentRevision));
    const count = inputs.length;
    const past = await bridge.execute({ type: 'memory.knowledge', ...scope, beforeSequence: source.sequence - 1, operation: 'search', query: 'canary' });
    expect(past.items).toEqual([]); expect(inputs).toHaveLength(count);
    const none = await bridge.execute({ type: 'memory.knowledge', ...scope, operation: 'search', query: 'canary', sourceIds: ['nonexistent-source'] });
    expect(none.items).toEqual([]); expect(inputs).toHaveLength(count);
    const bobScope = { companionId: 'bob', conversationId: store.openPrivate('bob').id };
    await expect(bridge.execute({ type: 'memory.knowledge', ...bobScope, operation: 'ingest', sourceType: 'memory', sourceId: note.id })).rejects.toThrow();
    const forgetting = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: 'Forget this source.' });
    store.request({ type: 'memory.forget', ...scope, id: note.id, requestMessageId: forgetting.id });
    expect((await bridge.execute({ type: 'memory.knowledge', ...scope, operation: 'search', query: 'canary' })).items).toEqual([]);
    await expect(bridge.execute({ type: 'memory.knowledge', ...scope, operation: 'read', id: receipt.result!.id })).rejects.toThrow();
    blocked = true; expect((await bridge.execute({ type: 'memory.knowledge', ...scope, operation: 'status' })).available).toBe(false);
    await bridge.reset('alice'); expect((await cold!.status('alice')).documents).toEqual([]);
  } finally { await runtime.close(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await removeOwnedDirectory(root); }
}, 120000);

it('ingests complete granted real library assets and immediately rejects changed, moved, revoked and truncated materials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-cold-library-'));
  const libraryService = new LibraryService();
  const library = libraryService.createLibrary({ displayName: '实际授权资料', selectedParentPath: root });
  const folder = libraryService.createManagedFolder({ libraryId: library.libraryId, name: 'Books' });
  const outside = libraryService.createManagedFolder({ libraryId: library.libraryId, name: 'Outside' });
  const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
  const db = new Database(path.join(library.libraryPath, '.worldlinebox/library.db'));
  const add = async (name: string, content: string) => {
    const assetId = randomUUID(), revision = randomUUID(), at = new Date().toISOString(), relative = folder.relativePath + '/' + name;
    db.prepare("INSERT INTO assets(asset_id,location_kind,managed_folder_id,linked_folder_id,relative_file_path,current_revision_id,availability,path_identity,created_at,updated_at) VALUES(?,'managed',?,NULL,?,NULL,'available',?,?,?)").run(assetId,folder.folderId,relative,relative,at,at);
    db.prepare("INSERT INTO revisions(revision_id,asset_id,parent_revision_id,byte_size,modified_at,original_filename,origin,accepted_at) VALUES(?,?,NULL,?,?,?,'import',?)").run(revision,assetId,Buffer.byteLength(content),at,name,at);
    db.prepare('UPDATE assets SET current_revision_id=? WHERE asset_id=?').run(revision,assetId);
    const file = libraryService.resolveAssetPath(library.libraryId,assetId); await mkdir(path.dirname(file),{recursive:true}); await writeFile(file,content);
    return {assetId,file,name};
  };
  const request = async (command: WorkerCommand): Promise<WorkerResult> => {
    switch(command.type) {
      case 'library.list': return {ok:true,type:'library.list',libraries:libraryService.listLibraries()};
      case 'folder.list': return {ok:true,type:'folder.list',folders:libraryService.listManagedFolders(command.libraryId)};
      case 'linked-folder.list': return {ok:true,type:'linked-folder.list',folders:libraryService.listLinkedFolders(command.libraryId)};
      case 'asset.learning.page': return {ok:true,type:'asset.learning.page',...libraryService.listLearningAssets(command)};
      case 'media.get-asset-path': return {ok:true,type:'media.asset-path',assetId:command.assetId,absolutePath:libraryService.resolveAssetPath(command.libraryId,command.assetId)};
      default: throw Error('Unexpected library command '+command.type);
    }
  };
  const assets = companionLearningAssets({request,memoryRoot:path.join(root,'cold')});
  const store = new CompanionsStore(path.join(root,'companions.db'),[{id:'alice',name:'Alice',description:'',persona:'认真',model:'',avatar:'sister',proactive:false,active:true}]);
  const scope={companionId:'alice',conversationId:store.openPrivate('alice').id};
  const source = store.appendMessage({conversationId:scope.conversationId,authorId:'user',content:'请阅读已授权资料。'});
  const grant=store.request({type:'learning.grant',companionId:'alice',libraryId:library.libraryId,libraryName:library.displayName,libraryPath:library.libraryPath,
    folderId:folder.folderId,folderName:folder.relativePath,autonomous:false,intervalMinutes:30}).learning!.grants[0]!;
  const embeddingInputs: string[]=[];
  const server=createServer(async(request,response)=>{let text='';for await(const chunk of request)text+=chunk;const body=JSON.parse(text) as {input:string[]};embeddingInputs.push(...body.input);
    response.setHeader('content-type','application/json');response.end(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:[1,0,0,0]}))}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
  let cold:ColdKnowledgeService|undefined;
  const runtime:CompanionMemoryRuntime={get:async()=>{throw Error('No hot model.');},close:async()=>{await cold?.close();},getCold:async (_scope,authorize)=>cold??=new ColdKnowledgeService({dataRoot:path.join(root,'cold'),vendorRoot:path.resolve('vendor/vcp-memory'),workerPath:path.resolve('src/main/vcp-memory/cold-worker.cjs'),embedding:{baseUrl:`http://127.0.0.1:${port}`,model:'fixture',modelSignature:'fixture',apiKey:'synthetic',dimension:4},authorize,launch})};
  const bridge=new CompanionKnowledgeService({request:async command=>store.request(command),runtime,assets});
  try {
    const content='完整授权资料。\n'+'Long factual material sentence with evidence.\n'.repeat(4000)+'FULL_SOURCE_FINAL_TAIL_CANARY';
    const asset=await add('full.md',content);
    const listed=await bridge.execute({type:'memory.knowledge',...scope,operation:'sources',sourceId:grant.id});
    expect(listed.sources?.some(item=>item.assetId===asset.assetId)).toBe(true);
    const receipt=await bridge.execute({type:'memory.knowledge',...scope,beforeSequence:source.sequence,operation:'ingest',sourceType:'learning',sourceId:grant.id,assetId:asset.assetId});
    expect(receipt.indexed).toBe(true);expect(receipt.result!.chunks).toBeGreaterThan(1);
    const read=await bridge.execute({type:'memory.knowledge',...scope,beforeSequence:source.sequence,operation:'read',id:receipt.result!.id});
    expect(read.result!.text).toBe(content);expect(embeddingInputs.some(text=>text.includes('FULL_SOURCE_FINAL_TAIL_CANARY'))).toBe(true);
    await writeFile(asset.file,content+' CHANGED_WITHOUT_DB_REVISION');
    expect((await bridge.execute({type:'memory.knowledge',...scope,operation:'search',query:'CANARY'})).items).toEqual([]);
    await expect(bridge.execute({type:'memory.knowledge',...scope,operation:'read',id:receipt.result!.id})).rejects.toThrow();
    await writeFile(asset.file,content);
    const newRelative=outside.relativePath+'/'+asset.name;db.prepare('UPDATE assets SET managed_folder_id=?,relative_file_path=? WHERE asset_id=?').run(outside.folderId,newRelative,asset.assetId);
    const moved=libraryService.resolveAssetPath(library.libraryId,asset.assetId);await mkdir(path.dirname(moved),{recursive:true});await rename(asset.file,moved);
    expect((await bridge.execute({type:'memory.knowledge',...scope,operation:'search',query:'CANARY'})).items).toEqual([]);
    const large=await add('oversize.md','A'.repeat(2097153));
    await expect(bridge.execute({type:'memory.knowledge',...scope,operation:'ingest',sourceType:'learning',sourceId:grant.id,assetId:large.assetId})).rejects.toThrow('截断');
    store.request({type:'learning.revoke',companionId:'alice',id:grant.id,expectedRevision:grant.revision});
    expect((await bridge.execute({type:'memory.knowledge',...scope,operation:'sources'})).sources).toEqual([]);
    expect((await bridge.execute({type:'memory.knowledge',...scope,operation:'search',query:'CANARY'})).items).toEqual([]);
  } finally {await runtime.close();store.close();db.close();libraryService.closeAll();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await removeOwnedDirectory(root);}
},120000);
