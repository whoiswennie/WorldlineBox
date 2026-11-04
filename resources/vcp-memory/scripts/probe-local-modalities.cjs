#!/usr/bin/env node
'use strict';
// Real inference with generated inputs only. This is an interface smoke, not an
// audio/video semantic-quality benchmark and never substitutes synthetic vectors.
const fs=require('node:fs');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {startLocalEmbedding,DEFAULT_BUNDLE}=require('../lib/local-embedding.cjs');
function wav() {
  const rate=16000,count=rate*2,bytes=Buffer.alloc(44+count*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
  for(let i=0;i<count;i++) bytes.writeInt16LE(Math.round(Math.sin(i/rate*440*Math.PI*2)*12000),44+i*2);
  return bytes.toString('base64');
}
async function main() {
  const report={createdAt:new Date().toISOString(),model:'embeddinggemma-2',dimension:768,backend:'cpu',syntheticVectors:false,
    scope:'Generated two-second sine audio and colored video verify actual typed input inference. They do not measure semantic retrieval quality.',modalities:{}};
  let session;
  try {
    session=await startLocalEmbedding({backend:'cpu'});
    const probe=async(name,action)=>{
      const at=performance.now();
      try {
        const vector=await action();
        const valid=vector.length===768&&vector.every(Number.isFinite)&&Math.abs(Math.hypot(...vector)-1)<1e-5;
        if(!valid) throw new Error('Actual encoder returned an invalid vector');
        report.modalities[name]={passed:true,dimension:vector.length,norm:Math.hypot(...vector),durationMs:performance.now()-at};
        return vector;
      } catch(error) {report.modalities[name]={passed:false,error:error.message,durationMs:performance.now()-at};process.exitCode=1;return null;}
    };
    await probe('audio',()=>session.embedAudioPayload(wav()));
    const render=async color=>{
      const {stdout}=await promisify(execFile)(path.join(DEFAULT_BUNDLE,'media','ffmpeg.exe'),[
        '-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=${color}:s=128x128:r=1:d=2`,
        '-an','-threads','1','-c:v','mpeg4','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1',
      ],{windowsHide:true,encoding:'buffer',maxBuffer:8*1024*1024,timeout:15000});
      return stdout.toString('base64');
    };
    let redInput,blueInput;
    try {redInput=await render('red');blueInput=await render('blue');}
    catch(error) {report.modalities.videoPreparation={passed:false,error:error.message};process.exitCode=1;}
    if(redInput&&blueInput) {
      const red=await probe('videoRed',()=>session.embedVideoPayload(redInput));
      const blue=await probe('videoBlue',()=>session.embedVideoPayload(blueInput));
      if(red&&blue) {
        const cosine=red.reduce((sum,value,index)=>sum+value*blue[index],0);
        report.videoContentCanary={passed:cosine<0.999,cosine,expected:'Distinct generated colors must affect the actual encoded video'};
        if(!report.videoContentCanary.passed) process.exitCode=1;
      }
    }
  } catch(error) {report.error=error.message;process.exitCode=1;}
  finally {
    if(session) {
      try {await session.close();report.closedSuccessfully=true;}
      catch(error) {report.closedSuccessfully=false;report.closeError=error.message;process.exitCode=1;}
    }
  }
  report.passed=process.exitCode!==1;
  const output=path.resolve(__dirname,'../reports/local-modalities-smoke.json');
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
