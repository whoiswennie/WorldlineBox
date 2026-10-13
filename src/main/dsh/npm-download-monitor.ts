/** Cooperative stream control inside the pinned npm process, never an OS thread suspension. */
export function npmDownloadMonitorSource(nonce: string): string {
  return `'use strict';\nconst NONCE=${JSON.stringify(nonce)};\n` + String.raw`
let paused=false, bytes=0, last=0;const streams=new Set();
const report=()=>{const now=Date.now();if(now-last<200)return;last=now;if(process.send)process.send({type:'worldline-download-bytes',nonce:NONCE,bytes},()=>{});};
for(const name of ['node:http','node:https']){const api=require(name),request=api.request;
api.request=function(...args){const req=request.apply(this,args);req.prependListener('response',res=>{
 const originalResume=res.resume.bind(res),originalPause=res.pause.bind(res);
 const item={pause(){originalPause();},resume(){originalResume();}};
 res.resume=function(){if(paused){originalPause();return res;}return originalResume();};
 streams.add(item);if(process.channel)process.channel.ref();res.on('data',chunk=>{bytes+=chunk.length;report();});
 res.once('close',()=>{streams.delete(item);if(streams.size===0&&process.channel)process.channel.unref();});if(paused)item.pause();
});return req;};}
process.on('message',msg=>{if(!msg||msg.nonce!==NONCE)return;
 if(msg.type==='pause'){paused=true;for(const item of streams)item.pause();}
 if(msg.type==='resume'){paused=false;for(const item of streams)item.resume();}
});
// IPC must not keep a finished npm installer alive. In-flight HTTP handles own its lifetime.
if(process.channel)process.channel.unref();
process.once('beforeExit',()=>{if(process.send)process.send({type:'worldline-download-bytes',nonce:NONCE,bytes},()=>{});});
`;
}
