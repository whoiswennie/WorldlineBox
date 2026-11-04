'use strict';
// Transport and lifetime adapter around WorldlineBox's unchanged llama.cpp session.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { startLlamaEmbeddingSession } = require('../upstream/worldline/compiled/embedding-llama-session.js');
const DEFAULT_BUNDLE = path.resolve(__dirname,'../vendor/local-embedding');
const MODEL = 'embeddinggemma-2';
const DIMENSION = 768;
const PREFIXES = {document:'title: none | text: ',query:'task: search result | query: '};
const verifiedBundles = new Map();
function sha256File(file) {
  return new Promise((resolve,reject)=>{
    const hash=crypto.createHash('sha256'),stream=fs.createReadStream(file);
    stream.on('data',chunk=>hash.update(chunk)); stream.once('error',reject); stream.once('end',()=>resolve(hash.digest('hex')));
  });
}
async function inspectLocalEmbedding(config={}) {
  const bundleDirectory=path.resolve(config.bundleDirectory || config.LOCAL_EMBEDDING_BUNDLE || process.env.VCP_LOCAL_EMBEDDING_BUNDLE || DEFAULT_BUNDLE);
  const manifest=JSON.parse(fs.readFileSync(path.join(bundleDirectory,'manifest.json'),'utf8'));
  const files=[];
  for(const entry of manifest.files) {
    const filename=path.resolve(bundleDirectory,entry.path);
    if(!filename.startsWith(bundleDirectory+path.sep)) throw new Error('Model manifest path escapes bundle');
    const stat=fs.statSync(filename);
    if(stat.size!==entry.bytes) throw new Error('Embedding weight size mismatch: '+entry.path);
    const key=filename+':'+stat.size+':'+stat.mtimeMs;
    if(verifiedBundles.get(key)!==entry.sha256) {
      if(await sha256File(filename)!==entry.sha256) throw new Error('Embedding weight hash mismatch: '+entry.path);
      verifiedBundles.set(key,entry.sha256);
    }
    files.push({path:entry.path,bytes:entry.bytes,sha256:entry.sha256});
  }
  return {bundleDirectory,model:MODEL,dimension:DIMENSION,revision:manifest.revision,files,
    platform:process.platform+'-'+process.arch,cpuAvailable:fs.existsSync(path.join(bundleDirectory,'runtime-cpu',process.platform==='win32'?'llama-server.exe':'llama-server')),
    vulkanAvailable:fs.existsSync(path.join(bundleDirectory,'runtime-vulkan',process.platform==='win32'?'llama-server.exe':'llama-server'))};
}
function normalize(vector) {
  if(!Array.isArray(vector)||vector.length!==DIMENSION||vector.some(value=>!Number.isFinite(value))) throw new Error('Local encoder returned an invalid 768-dimensional vector');
  const norm=Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0));
  if(!norm) throw new Error('Local encoder returned a zero vector');
  return vector.map(value=>value/norm);
}
function meanPool(vectors) {
  const result=Array(DIMENSION).fill(0);
  for(const vector of vectors) for(let i=0;i<DIMENSION;i++) result[i]+=vector[i]/vectors.length;
  return normalize(result);
}
async function startLocalEmbedding(config={}) {
  const inspection=await inspectLocalEmbedding(config);
  const bundle=inspection.bundleDirectory;
  const requested=config.backend || config.LOCAL_EMBEDDING_BACKEND || 'auto';
  if(!['auto','cpu','vulkan'].includes(requested)) throw new Error('Local embedding backend must be auto, cpu, or vulkan');
  const candidates=requested==='auto' ? ['vulkan','cpu'] : [requested];
  let session,backend,lastError;
  const ffmpeg=path.join(bundle,'media','ffmpeg.exe'),ffprobe=path.join(bundle,'media','ffprobe.exe');
  const mediaAvailable=fs.existsSync(ffmpeg)&&fs.existsSync(ffprobe);
  const startedAt=Date.now();
  for(const candidate of candidates) {
    const executable=path.join(bundle,'runtime-'+candidate,process.platform==='win32'?'llama-server.exe':'llama-server');
    if(!fs.existsSync(executable)) {lastError=new Error('Bundled local runtime is unavailable for '+process.platform+'/'+process.arch);continue;}
    try {
      session=await startLlamaEmbeddingSession({executable,
        files:{corePath:path.join(bundle,'embeddinggemma-2-UD-Q4_K_XL.gguf'),projectorPath:path.join(bundle,'mmproj-Q8_0.gguf')},
        ...(mediaAvailable?{mediaBinaries:{ffmpegPath:ffmpeg,ffprobePath:ffprobe}}:{}),
        gpuLayers:candidate==='vulkan'?99:0,threads:Number(config.threads || config.LOCAL_EMBEDDING_THREADS)||4,
        contextSize:8192,pooling:'mean',koffiPath:require.resolve('koffi'),
        startupTimeoutMs:Number(config.startupTimeoutMs)||120000,requestTimeoutMs:Number(config.requestTimeoutMs)||180000});
      backend=candidate;break;
    } catch(error) {lastError=error;}
  }
  if(!session) throw new Error('Could not start local EmbeddingGemma 2: '+(lastError?.message||'runtime unavailable'),{cause:lastError});
  let closed=false,tail=Promise.resolve();
  const enqueue=fn=>{
    const work=tail.then(()=>{if(closed) throw new Error('Local embedding session is closed');return fn();});
    tail=work.catch(()=>{});return work;
  };
  async function encodeText(text,purpose) {
    if(typeof text!=='string'||text.length>1000000) throw new TypeError('Embedding input must be text with at most 1000000 characters');
    const prefix=PREFIXES[purpose],remaining=[text],chunks=[];
    while(remaining.length) {
      const current=remaining.shift();
      if(await session.countTokens(prefix+current)<=8000) {chunks.push(prefix+current);continue;}
      const points=Array.from(current);
      if(points.length<2) throw new Error('One character cannot fit in the local encoder context');
      const mid=Math.floor(points.length/2);
      remaining.unshift(points.slice(mid).join(''));remaining.unshift(points.slice(0,mid).join(''));
    }
    const vectors=[];
    for(const chunk of chunks) vectors.push(normalize(await session.embedText(chunk)));
    return vectors.length===1?vectors[0]:meanPool(vectors);
  }
  const embed=(texts,options={})=>enqueue(async()=>{
    if(!Array.isArray(texts)||texts.length>512) throw new TypeError('Embedding batch must contain at most 512 texts');
    const purpose=options.purpose==='query'?'query':'document',vectors=[];
    for(const text of texts) vectors.push(await encodeText(text,purpose));
    return vectors;
  });
  const apiKey=crypto.randomBytes(32).toString('hex');
  const sockets=new Set();
  const server=http.createServer(async(request,response)=>{
    try {
      if(request.method!=='POST'||!/^\/(?:document|query)\/v1\/embeddings$/.test(request.url||'')) {response.writeHead(404);response.end();return;}
      const provided=Buffer.from(String(request.headers.authorization||'').replace(/^Bearer /,'')),expected=Buffer.from(apiKey);
      if(provided.length!==expected.length||!crypto.timingSafeEqual(provided,expected)) {response.writeHead(401);response.end();return;}
      const chunks=[];let bytes=0;
      for await(const chunk of request) {bytes+=chunk.length;if(bytes>8*1024*1024) throw new Error('Local embedding request exceeds 8 MiB');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const texts=typeof body.input==='string'?[body.input]:body.input;
      const vectors=await embed(texts,{purpose:request.url.startsWith('/query/')?'query':'document'});
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({object:'list',model:MODEL,data:vectors.map((embedding,index)=>({object:'embedding',index,embedding}))}));
    } catch(error) {response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}));}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  try {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
  catch(error) {await session.close();throw error;}
  const base='http://127.0.0.1:'+server.address().port;
  let closing;
  return {
    documentUrl:base+'/document',queryUrl:base+'/query',baseUrl:base+'/document',queryBaseUrl:base+'/query',apiKey,model:MODEL,dimension:DIMENSION,
    modelSignature:`embeddinggemma-2:${inspection.revision}:Q4_K_XL:768:mean:8192:worldline-v1`,
    capabilities:{text:true,image:true,audio:true,video:mediaAvailable,backend,dimension:DIMENSION,source:'local',startupMs:Date.now()-startedAt},
    status:()=>({model:MODEL,dimension:DIMENSION,backend,closed,bundleDirectory:bundle,source:'local'}),embed,
    embedImage:filename=>enqueue(async()=>normalize(await session.embedImage(filename))),
    embedImagePayload:(mime,base64)=>enqueue(async()=>normalize(await session.embedImagePayload(mime,base64))),
    embedAudio:filename=>enqueue(async()=>normalize(await session.embedAudio(filename))),
    embedAudioPayload:base64=>enqueue(async()=>normalize(await session.embedAudioPayload(base64))),
    embedVideoPayload:(video,audio)=>enqueue(async()=>normalize(await session.embedVideoPayload(video,audio))),
    close:()=>closing??=(async()=>{
      closed=true;server.closeIdleConnections();for(const socket of sockets) socket.destroy();
      await new Promise(resolve=>server.close(resolve));
      // The original owner closes its Windows Job, including the llama runtime.
      await session.close();await tail;
    })(),
  };
}
module.exports={startLocalEmbedding,inspectLocalEmbedding,DEFAULT_BUNDLE,MODEL,DIMENSION};
