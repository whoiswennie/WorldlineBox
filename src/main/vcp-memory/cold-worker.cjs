/* global require, process, setTimeout */
'use strict';
const {ColdKnowledgeRuntime}=require('./cold-runtime.cjs');
const runtime=new ColdKnowledgeRuntime(),port=process.parentPort;
const send=value=>port?port.postMessage(value):process.send?.(value);
let tail=Promise.resolve();
function receive(value){const request=port?value.data:value;tail=tail.then(async()=>{
  if(!request||typeof request.requestId!=='string'||!request.command)return;
  try {
    const command=request.command;let result;
    switch(command.type){case'initialize':result=await runtime.initialize(command.configuration);break;case'build':result=await runtime.build(command);break;case'search':result=await runtime.search(command);break;case'barrier':result={ready:true};break;case'close':result=await runtime.close();break;default:throw Error('Unknown cold operation.');}
    send({requestId:request.requestId,ok:true,value:result});if(command.type==='close')setTimeout(()=>process.exit(0),10);
  }catch(error){send({requestId:request.requestId,ok:false,error:{message:String(error.message||error)}});}
}).catch(()=>send({type:'fatal'}));}
if(port)port.on('message',receive);else process.on('message',receive);
process.once('disconnect',()=>{const forced=setTimeout(()=>process.exit(1),5000);forced.unref();void tail.catch(()=>undefined).then(()=>runtime.close()).catch(()=>undefined).finally(()=>process.exit(0));});
