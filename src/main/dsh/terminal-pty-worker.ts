export const PTY_WORKER_MARKER = '// WorldlineBox managed ConPTY worker v1';

/** Native ConPTY lives in a disposable process, never in Electron's main process. */
export function terminalPtyWorkerSource(nodePtyModule: string): string {
  return `${PTY_WORKER_MARKER}\n` + String.raw`
'use strict';
const NODE_PTY=${JSON.stringify(nodePtyModule)};
let terminal,started=false,closing=false,exited=false,sending=false,paused=false;
let queued=[],queuedLength=0,exitCode=0,forceTimer,revision=0;
function finish(){if(!exited||sending||queued.length)return;process.send?.({type:'exit',exitCode},()=>process.exit(exitCode));forceTimer=setTimeout(()=>process.exit(exitCode),1000)}
function drain(){if(sending||!queued.length){finish();return}sending=true;const entry=queued.shift();queuedLength-=entry.data.length;process.send({type:'data',...entry},error=>{sending=false;if(error)process.exit(1);if(paused&&queuedLength<32768&&!exited){paused=false;try{terminal.resume()}catch{}}drain()})}
function output(data){for(let at=0;at<data.length;){let end=Math.min(data.length,at+16384);if(end<data.length&&/[\uD800-\uDBFF]/u.test(data[end-1])&&/[\uDC00-\uDFFF]/u.test(data[end]))end--;const chunk=data.slice(at,end);queued.push({data:chunk,revision});queuedLength+=chunk.length;at=end}if(!paused&&queuedLength>131072){paused=true;terminal.pause()}drain()}
function stop(code){if(exited)return;exited=true;exitCode=Number.isInteger(code)&&code>=0&&code<=255?code:1;finish();forceTimer=setTimeout(()=>process.exit(exitCode),2000)}
process.on('message',message=>{
 try{
  if(!message||typeof message!=='object')return;
  if(message.type==='start'){
   if(started)throw Error('PTY_ALREADY_STARTED');started=true;
   const pty=require(NODE_PTY);
   terminal=pty.spawn(message.file,message.args,{name:'xterm-256color',cols:message.cols,rows:message.rows,cwd:message.cwd,env:message.env,useConptyDll:false});
   terminal.onData(output);terminal.onExit(event=>stop(event.exitCode));
   process.send({type:'ready',pid:terminal.pid});return;
  }
  if(message.type==='close'){
   closing=true;try{terminal?.kill()}catch{}stop(0);return;
  }
  if(!terminal||exited)return;
  if(message.type==='input'&&typeof message.text==='string'&&Buffer.byteLength(message.text,'utf8')<=65536)terminal.write(message.text);
  else if(message.type==='resize'&&Number.isInteger(message.cols)&&Number.isInteger(message.rows)&&message.cols>=2&&message.cols<=600&&message.rows>=2&&message.rows<=300)terminal.resize(message.cols,message.rows);
  else if(message.type==='clear'){revision=message.revision;queued=[];queuedLength=0;if(paused){paused=false;terminal.resume()}try{terminal.clear?.()}catch{}terminal.write('\x0c')}
 }catch{process.send?.({type:'error',code:started?'PTY_OPERATION_FAILED':'PTY_START_FAILED'});if(!closing){try{terminal?.kill()}catch{}stop(1)}}
});
process.on('disconnect',()=>{try{terminal?.kill()}catch{}process.exit(0)});
process.on('uncaughtException',()=>{try{terminal?.kill()}catch{}process.exit(1)});
process.on('unhandledRejection',()=>{try{terminal?.kill()}catch{}process.exit(1)});
process.send?.({type:'booted'});
`;
}
