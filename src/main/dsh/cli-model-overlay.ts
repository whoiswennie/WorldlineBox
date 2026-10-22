export const CLI_MODEL_OVERLAY_MARKER='// WorldlineBox managed native CLI model overlay v1';

/** Compose native layers without booting plugins or evaluating their !!js expressions. */
export function cliModelOverlaySource():string{return `${CLI_MODEL_OVERLAY_MARKER}\n`+String.raw`
import{createRequire}from'node:module';import{pathToFileURL}from'node:url';import path from'node:path';import{existsSync}from'node:fs';import{readFile,lstat,writeFile,mkdir}from'node:fs/promises';
const[program,profileName,canonicalFile,instanceId,patchesJson,output]=process.argv.slice(2);
const fields={'llm-deepseek':['baseURL','thinking','reasoningEffort','maxTokens','defaultContextWindow','models','streamIdleTimeoutMs','maxRequestFilesBytes','maxInlineRequestImageBytes','maxImagesPerRequest','imageOffloadByteQuantum','inlineImageOffloadByteQuantum','imageOffloadCountQuantum','filesApiTimeoutMs','fileExpiresAfterSeconds','fileRefreshMarginSeconds','fileQuotaCleanupBatch','retryPolicy','apiKeyEnv'],'llm-deepseek-account':['baseURL','thinking','reasoningEffort','maxTokens','defaultContextWindow','models','streamIdleTimeoutMs','maxRequestFilesBytes','maxInlineRequestImageBytes','maxImagesPerRequest','imageOffloadByteQuantum','inlineImageOffloadByteQuantum','imageOffloadCountQuantum','filesApiTimeoutMs','fileExpiresAfterSeconds','fileRefreshMarginSeconds','fileQuotaCleanupBatch','retryPolicy'],'llm-pi-ai':['providers'],'agent-default-model':['provider','model','reasoningEffort']};
const names={'llm-deepseek':'@deepseek-ai/dsh-llm-deepseek-api-key','llm-deepseek-account':'@deepseek-ai/dsh-llm-deepseek-account','llm-pi-ai':'@deepseek-ai/dsh-llm-pi-ai','agent-default-model':'@deepseek-ai/dsh-agent-default-model'};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);const own=(value,key)=>record(value)&&Object.hasOwn(value,key);
function safe(value,depth=0){if(depth>50)throw Error('CLI_MODEL_COMPLEX');if(Array.isArray(value)){for(const item of value)safe(item,depth+1)}else if(record(value)){for(const[key,item]of Object.entries(value)){if(['__proto__','prototype','constructor','__jsExpr'].includes(key))throw Error('CLI_MODEL_DYNAMIC');safe(item,depth+1)}}}
function project(entries){const map=new Map();const walk=rows=>{for(const row of rows){if(Object.hasOwn(fields,row.id)){if(map.has(row.id))throw Error('CLI_MODEL_AMBIGUOUS');map.set(row.id,row)}if(Array.isArray(row.config))walk(row.config)}};walk(entries);return map}
function merged(current,base,next,defaults){if(next===undefined)return defaults===undefined?undefined:structuredClone(defaults);if(record(next)&&!own(next,'__jsExpr')){if(own(current,'__jsExpr')||own(defaults,'__jsExpr'))throw Error('CLI_MODEL_DYNAMIC_MERGE');const result=record(current)?structuredClone(current):record(defaults)?structuredClone(defaults):{};for(const key of new Set([...Object.keys(record(base)?base:{}),...Object.keys(next)])){const value=merged(result[key],record(base)?base[key]:undefined,next[key],record(defaults)?defaults[key]:undefined);if(value===undefined)delete result[key];else result[key]=value}return result}return structuredClone(next)}
try{
 const info=await lstat(canonicalFile);if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)throw Error('CLI_MODEL_FILE');
 const store=JSON.parse(await readFile(canonicalFile,'utf8'));if(store.version!==1||!record(store.values))throw Error('CLI_MODEL_STORE');safe(store.values);safe(store.clients??{});
 const sdk=existsSync(path.join(program,'node-runtime.json'))?path.join(program,'dsh/node_modules'):path.join(program,'resources/app.asar/dsh/node_modules');
 const anchor=path.join(sdk,'@deepseek-ai/dsh/package.json'),load=createRequire(anchor);
 const native=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-app-boot')));
 // A fresh launcher instance has no manifest until its first official CLI boot.
 // Initialize only that absent profile with its native template; configured
 // profiles retain their exact manifest instead of triggering normalization.
 const profileDirectory=native.resolveProfileDir(profileName,process.env.DSH_HOME);
 if(!existsSync(path.join(profileDirectory,'package.json'))){const template=native.PROFILE_TEMPLATES[profileName];if(!template)throw Error('CLI_MODEL_PROFILE');native.initProfile(profileDirectory,template.bundles)}
 const profile=native.loadProfileDirectory('dsh',profileDirectory,anchor,{userLayer:true});
 const overlays=JSON.parse(patchesJson).flatMap(file=>native.loadOverlayPatches('dsh',file));
 const context={dir:profile.dir,patchPath:profile.patchPath,installAnchor:anchor,home:process.env.DSH_HOME,overlays,telemetryDisabledEnv:process.env.DSH_TELEMETRY_DISABLED};
 const effective=project(native.composeEntries([native.readProfilePatches('dsh',context,profile)]));const defaults=project(native.composeEntries(profile.layers.map(layer=>layer.patches)));
 const baseline=store.clients?.[instanceId]??{};const result=[];
 for(const[id,allowed]of Object.entries(fields)){
  const shared=store.values[id]??{},previous=baseline[id]??{};if(!record(shared)||!record(previous))throw Error('CLI_MODEL_VALUES');
  if(!allowed.some(key=>own(shared,key)||own(previous,key)))continue;
  const current=effective.get(id);if(!current)continue;if(current.name!==names[id]||current.config!==undefined&&(!record(current.config)||own(current.config,'__jsExpr')))throw Error('CLI_MODEL_NATIVE_SHAPE');
  const config=structuredClone(current.config??{}),base=defaults.get(id)?.config;
  for(const key of allowed){if(!own(shared,key)&&!own(previous,key))continue;const value=merged(config[key],previous[key],shared[key],record(base)?base[key]:undefined);if(value===undefined)delete config[key];else config[key]=value}
  result.push({id,config});
 }
 await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
}catch{process.stderr.write('CLI_MODEL_OVERLAY_REFUSED\n');process.exitCode=1}
`;}
