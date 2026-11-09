import {expect,it,vi} from 'vitest';
const bridgePath='../../resources/dsh-bridge/index.js';
async function fixture(){
  const {compactBotTopic}=await import(bridgePath),receipts=new Map<string,Record<string,unknown>>(),events:Array<{type:string;seq:number;data:Record<string,unknown>}>=[];
  const session={snapshotEvents:()=>events,append:(type:string,data:Record<string,unknown>)=>events.push({type,data,seq:events.length+1})};
  const record={status:'succeeded',admissions:0,agent:{status:'idle',session}},handler=vi.fn(async({commandId}:{commandId:string})=>{
    session.append('compaction/start',{sourceCommandId:commandId});session.append('compaction/summary',{sourceCommandId:commandId});const summarySeq=events.length;
    session.append('compaction/end',{sourceCommandId:commandId});return{kind:'success',sourceEventSeq:summarySeq};});
  const effects={read:async(key:string)=>receipts.get(key),write:async(value:Record<string,unknown>)=>{receipts.set(String(value.eventId),value);},flush:vi.fn(async()=>{}),findCommand:()=>({handler})};
  return{record,receipts,events,handler,effects,run:()=>compactBotTopic(record,'request',effects)};
}
it('calls the preset-owned native command and preserves its lifecycle with an idempotent receipt',async()=>{
  const f=await fixture();expect(await f.run()).toEqual({compacted:true});expect(await f.run()).toEqual({compacted:true});expect(f.handler).toHaveBeenCalledOnce();expect(f.events.map(event=>event.type)).toEqual(['command/run','compaction/start','compaction/summary','compaction/end','command/done']);
});
it('recovers successful native compaction after its final receipt write was lost',async()=>{
  const f=await fixture();let failed=true;f.effects.write=async(value)=>{if(value.status==='complete'&&failed)throw Error('lost receipt');f.receipts.set(String(value.eventId),value);};
  await expect(f.run()).rejects.toThrow('lost');failed=false;expect(await f.run()).toEqual({compacted:true});expect(f.handler).toHaveBeenCalledOnce();
});
it('does not repeat compaction when summary and end were committed before command completion',async()=>{
  const f=await fixture();f.record.agent.session.append('command/run',{commandId:'cmd-worldlinebox-'+(await import('node:crypto')).createHash('sha256').update('request').digest('hex').slice(0,32)});
  const commandId=f.events[0]!.data.commandId;f.record.agent.session.append('compaction/start',{sourceCommandId:commandId});f.record.agent.session.append('compaction/summary',{sourceCommandId:commandId});f.record.agent.session.append('compaction/end',{sourceCommandId:commandId});
  expect(await f.run()).toEqual({compacted:true});expect(f.handler).not.toHaveBeenCalled();
});
