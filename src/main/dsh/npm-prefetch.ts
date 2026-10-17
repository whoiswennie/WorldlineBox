/** Uses the dependency fetcher shipped with the pinned npm, with the same SRI/cache format. */
export function npmPrefetchSource(npmCli: string, tarballMirror?: string): string {
  if (tarballMirror && tarballMirror !== 'https://registry.npmmirror.com') throw new Error('Unsupported automatic archive mirror.');
  return `'use strict';\nconst npmCli=${JSON.stringify(npmCli)},mirror=${JSON.stringify(tarballMirror ?? '')};\n` + String.raw`
const fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const load=createRequire(npmCli);
if(fs.statSync('package-lock.json').size>32*1024*1024)throw Error('Dependency lock exceeds its supported size.');
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
if(lock.lockfileVersion!==3||!lock.packages||Object.keys(lock.packages).length>100000)throw Error('Unsupported npm dependency lock.');
const matches=(rules,value)=>!rules||(!rules.includes('!'+value)&&(rules.every(x=>x.startsWith('!'))||rules.includes(value)||rules.includes('any')));
const unique=new Map();let locations=0;
for(const item of Object.values(lock.packages)){
 if(item.dev===true||!item.resolved||item.inBundle||item.resolved.startsWith('file:'))continue;
 if(!matches(item.os,process.platform)||!matches(item.cpu,process.arch))continue;
 const url=new URL(item.resolved);
 if(url.protocol!=='https:'||url.username||url.password||!item.integrity)throw Error('Dependency must have an HTTPS source and integrity.');
 const key=item.integrity+' '+url.href,previous=unique.get(key);
 if(previous)previous.optional=previous.optional&&item.optional===true;
 else unique.set(key,{url:url.href,integrity:item.integrity,optional:item.optional===true});
 if(++locations>100000)throw Error('Dependency graph exceeds its supported size.');
}
const entries=[...unique.values()];let next=0,completed=0;const started=Date.now();
const pacote=entries.length?load('pacote'):null;
let last=-Infinity;
const emit=()=>{const now=Date.now();if(completed!==entries.length&&now-last<250)return;last=now;console.log('WORLDLINE_PREFETCH '+JSON.stringify({completed,total:entries.length,locations}));};emit();
const options={cache:path.join(process.env.npm_config_cache,'_cacache'),preferOffline:true,registry:process.env.npm_config_registry,
 proxy:process.env.HTTPS_PROXY||null,noProxy:process.env.NO_PROXY||'',maxSockets:8,
 timeout:120000,fetchRetries:2,fetchRetryFactor:2,fetchRetryMintimeout:1000,fetchRetryMaxtimeout:10000};
const consume=stream=>{stream.resume();return stream.promise();};
const mirrored=url=>mirror+new URL(url).pathname;
let selectedMirror=false;
async function selectRoute(){
 const sample=entries.find(x=>new URL(x.url).hostname==='registry.npmjs.org'&&x.url.includes('/zod/-/'))||entries.find(x=>new URL(x.url).hostname==='registry.npmjs.org');
 if(!mirror||!sample)return;
 const controllers=[new AbortController(),new AbortController()];
 const candidates=[sample.url,mirrored(sample.url)];
 try{
  const winner=await Promise.any(candidates.map(async(url,i)=>{
   await pacote.tarball.stream(url,consume,{...options,integrity:sample.integrity,fetchRetries:0,signal:AbortSignal.any([controllers[i].signal,AbortSignal.timeout(15000)])});return i;
  }));
  selectedMirror=winner===1;
  console.log('Dependency archive route: '+(selectedMirror?mirror:'https://registry.npmjs.org')+' (SRI verified, configured proxy retained)');
 }catch{console.log('Archive route probe unavailable; using configured registry with bounded retries.');}
 finally{for(const controller of controllers)controller.abort();}
}
async function fetchItem(item){
 const useMirror=selectedMirror&&new URL(item.url).hostname==='registry.npmjs.org';
 try{await pacote.tarball.stream(useMirror?mirrored(item.url):item.url,consume,{...options,integrity:item.integrity});}
 catch(error){if(!useMirror)throw error;await pacote.tarball.stream(item.url,consume,{...options,integrity:item.integrity});}
}
async function worker(){while(next<entries.length){const item=entries[next++];
 try{await fetchItem(item);}
 catch(error){if(!item.optional)throw error;console.warn('Optional package unavailable: '+item.url+' '+error.message);}
 completed++;emit();
}}
selectRoute().then(()=>Promise.all(Array.from({length:Math.min(8,entries.length)},worker))).then(()=>{
 console.log('Dependency archives verified: '+entries.length+' unique / '+locations+' locations in '+(Date.now()-started)+' ms');
},error=>{console.error(error);process.exit(1);});
`;
}
