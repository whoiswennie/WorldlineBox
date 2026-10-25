/* global require, module, process */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { bindRuntimeDependencies, unlinkRuntimeDependency } = require('./runtime.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
function key(value, generation = false) { if (typeof value !== 'string' || !(generation ? /^[a-f0-9-]{36}$/ : /^[a-f0-9]{64}$/).test(value)) throw Error('Invalid cold storage identity.'); return value; }
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function atomic(file, value) { const temporary = file+'.'+randomUUID()+'.tmp'; const out = await fs.open(temporary,'wx',0o600); try { await out.writeFile(JSON.stringify(value)); await out.sync(); } finally { await out.close(); } await fs.rename(temporary,file); }
class ColdKnowledgeRuntime {
  async initialize(configuration) {
    if (this.configuration) throw Error('Cold worker already initialized.');
    const { embedding } = configuration;
    const url = new URL(embedding.baseUrl);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !Number.isInteger(embedding.dimension) || embedding.dimension < 1 || embedding.dimension > 4096) throw Error('Invalid cold embedding configuration.');
    this.configuration = configuration; this.root = path.resolve(configuration.dataRoot);
    const runtime = path.join(this.root,'runtime'); await fs.mkdir(runtime,{recursive:true});
    if ((await fs.lstat(runtime)).isSymbolicLink()) throw Error('Cold runtime cannot be linked.');
    for (const file of ['TDBKnowledge.js','TextChunker.js','EmbeddingUtils.js']) await fs.copyFile(path.join(configuration.vendorRoot,file),path.join(runtime,file));
    await fs.writeFile(path.join(runtime,'package.json'),'{"type":"commonjs"}');
    const vendorLoad = createRequire(path.join(configuration.vendorRoot,'package.json'));
    let tokenizer = path.dirname(vendorLoad.resolve('@dqbd/tiktoken'));
    while ((await json(path.join(tokenizer,'package.json')).catch(()=>({}))).name !== '@dqbd/tiktoken') { const parent=path.dirname(tokenizer); if(parent===tokenizer)throw Error('Cold tokenizer dependency unavailable.');tokenizer=parent; }
    const dependencies = path.dirname(path.dirname(tokenizer)), link=path.join(runtime,'node_modules');
    await unlinkRuntimeDependency(runtime,link,dependencies);
    this.dependencyBinding=bindRuntimeDependencies(runtime,path.resolve(configuration.vendorRoot));
    this.cwd = await fs.mkdtemp(path.join(tmpdir(),'worldline-cold-cwd-')); process.chdir(this.cwd);
    for(const name of Object.keys(process.env))if(/^TDB_KNOWLEDGE_/u.test(name))delete process.env[name];
    Object.assign(process.env,{ API_URL:url.toString().replace(/\/+$/u,'').replace(/\/v1$/u,''),API_Key:embedding.apiKey,
      WhitelistEmbeddingModel:embedding.model,WhitelistEmbeddingModelMaxToken:'8000',VECTORDB_DIMENSION:String(embedding.dimension),EMBEDDING_SEND_DIMENSIONS:'true',EMBEDDING_AUDIT_LOG_ENABLED:'false' });
    const load=createRequire(path.join(runtime,'package.json'));
    this.Manager=load('./TDBKnowledge.js').constructor; this.chunkText=load('./TextChunker.js').chunkText;
    this.getEmbeddingsBatch=load('./EmbeddingUtils.js').getEmbeddingsBatch;
    return {ready:true,engine:'original-TDBKnowledge',packageVersion:load('triviumdb/package.json').version};
  }
  owner(value){return path.join(this.root,'owners',key(value));}
  generation(owner,id){return path.join(this.owner(owner),'generations',key(id,true));}
  sourcePath(document){return path.join('Knowledge',hash(document.id)+'.md');}
  async manager(directory) {
    const manager=new this.Manager({enabled:true,rootPath:path.join(directory,'knowledge'),storePath:path.toNamespacedPath(path.join(directory,'store')),
      dimension:this.configuration.embedding.dimension,model:this.configuration.embedding.model,fullScanOnStartup:false,batchWindow:60000,queuePollIntervalMs:60000,flushEveryFiles:1,buildTextIndexEveryFiles:1});
    await manager.initialize();return manager;
  }
  async build(command) {
    const directory=this.generation(command.owner,command.generation); await fs.mkdir(directory,{recursive:true});
    if((await fs.lstat(directory)).isSymbolicLink())throw Error('Cold generation cannot be linked.');
    let previous;
    if(command.previous) {
      const prior=this.generation(command.owner,command.previous);previous=await json(path.join(prior,'manifest.json'));
      if(previous.status!=='ready'||previous.embeddingKey!==command.embeddingKey)throw Error('Cold prior generation is incomplete.');
      await fs.cp(path.join(prior,'store'),path.join(directory,'store'),{recursive:true});
    }
    const records=[];
    for(const document of command.documents) {
      key(document.snapshot);key(document.version);
      const snapshot=await json(path.join(this.owner(command.owner),'snapshots',document.snapshot+'.json'));
      if(snapshot.id!==document.id||snapshot.version!==document.version||hash(snapshot.text)!==document.contentDigest)throw Error('Cold immutable snapshot changed.');
      const source=path.join(directory,'knowledge',this.sourcePath(document));await fs.mkdir(path.dirname(source),{recursive:true});await fs.writeFile(source,snapshot.text,'utf8');
      records.push({...document,expectedChunks:this.chunkText(snapshot.text).filter(Boolean).length});
    }
    const manager=await this.manager(directory); const chunks={};
    try {
      for(const old of previous?.documents||[])if(!records.some(item=>item.id===old.id))await manager.deleteFile(path.join(directory,'knowledge',this.sourcePath(old)));
      for(const document of records) {
        const source=this.sourcePath(document);await manager.upsertFile(path.join(directory,'knowledge',source));
        const observed=manager.metaDb.prepare('SELECT COUNT(*) AS n FROM chunks WHERE path = ?').get(source).n;
        const file=manager.metaDb.prepare('SELECT doc_node_id FROM files WHERE path = ?').get(source);
        if(observed!==document.expectedChunks||!observed||file?.doc_node_id==null)throw Error('Cold source has incomplete chunk embeddings; generation was not published.');
        chunks[document.id]=observed;
      }
    } finally { await manager.shutdown(); }
    const manifest={status:'ready',generation:command.generation,embeddingKey:command.embeddingKey,documents:records.map(item=>({...item,chunks:chunks[item.id]}))};
    await atomic(path.join(directory,'manifest.json'),manifest);
    return {generation:command.generation,chunks};
  }
  async search(command) {
    const directory=this.generation(command.owner,command.generation),manifest=await json(path.join(directory,'manifest.json'));
    if(manifest.status!=='ready'||manifest.embeddingKey!==command.embeddingKey)throw Error('Cold generation is unavailable or belongs to another embedding space.');
    const allowed=command.documents.filter(item=>manifest.documents.some(stored=>stored.id===item.id&&stored.version===item.version));
    if(!allowed.length)return [];
    const [vector]=await this.getEmbeddingsBatch([command.text],{apiKey:this.configuration.embedding.apiKey,
      apiUrl:(this.configuration.embedding.queryBaseUrl||this.configuration.embedding.baseUrl).replace(/\/+$/u,'').replace(/\/v1$/u,''),model:this.configuration.embedding.model});
    if(!vector)throw Error('Cold query embedding unavailable.');
    const manager=await this.manager(directory);const results=[];
    try {
      // Filter the native search BEFORE ranking. Cross-source graph expansion cannot select an unauthorized source.
      for(const document of allowed) {
        const hits=await manager.searchWithVector(vector,command.text,{libraries:['Knowledge'],topK:command.topK,expandDepth:1,minScore:0,
          payloadFilter:{type:'chunk',source_path:this.sourcePath(document)},expand:!!command.expand});
        for(const hit of hits)if(hit.sourceFile===this.sourcePath(document)) {
          const source={...document};delete source.snapshot;delete source.status;
          results.push({...source,text:hit.text,score:hit.score||0,chunkIndex:hit.chunkIndex,generation:command.generation});
        }
      }
    } finally {await manager.shutdown();}
    return results.sort((a,b)=>b.score-a.score).slice(0,command.topK);
  }
  async close(){
    this.dependencyBinding?.deregister();this.dependencyBinding=undefined;
    if(this.cwd){process.chdir(tmpdir());await fs.rmdir(this.cwd);this.cwd=undefined;}return{closed:true};
  }
}
module.exports={ColdKnowledgeRuntime};
