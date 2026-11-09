import {expect,it} from 'vitest';
import {botContextOccupancy,botNativeContextSchema} from '../../src/shared/companion-native-context';
const bridgePath='../../resources/dsh-bridge/index.js';
const {nativeContextSample}=await import(bridgePath);
it('uses the exact native projected occupancy, independently of heuristic composition and lifetime expenditure',()=>{
  const sample=botNativeContextSchema.parse(nativeContextSample('native-session',{kind:'sequenced',asOfSeq:42,values:{contextPressure:{pressureTokens:32000,projectedTokens:6000,contextWindow:128000},contextBreakdown:{systemTokens:120,toolsTokens:21500,messageTokens:477000},tokenUsage:{uncachedInputTokens:500000,cacheReadTokens:900000,cacheWriteTokens:100000,outputTokens:80000}}}));
  expect(botContextOccupancy(sample)).toEqual({tokens:6000,capacity:128000,percent:5});expect(sample.breakdown?.messageTokens).toBe(477000);expect(sample.usage?.cacheReadTokens).toBe(900000);expect(sample.asOfSeq).toBe(42);
});
it('does not invent capacity, pressure or a zero reading before the provider reports them',()=>{
  expect(botContextOccupancy(botNativeContextSchema.parse(nativeContextSample('s',null)))).toBeUndefined();
  expect(botContextOccupancy(botNativeContextSchema.parse(nativeContextSample('s',{kind:'sequenced',values:{contextPressure:{contextWindow:128000}}})))).toBeUndefined();
  expect(botContextOccupancy(botNativeContextSchema.parse(nativeContextSample('s',{kind:'sequenced',values:{contextPressure:{pressureTokens:0,contextWindow:128000}}})))?.percent).toBe(0);
});
it('forwards only public numeric projections and distinguishes migration hints from an exact sequenced reading',()=>{
  const value=nativeContextSample('s',{kind:'migration-required',values:{contextPressure:{pressureTokens:30,contextWindow:100,apiKey:'SECRET'},contextBreakdown:{systemTokens:1,toolsTokens:2,messageTokens:3,prompt:'SECRET'},tokenUsage:{uncachedInputTokens:1,cacheReadTokens:2,cacheWriteTokens:3,outputTokens:4},configuration:{token:'SECRET'}}});
  expect(JSON.stringify(value)).not.toContain('SECRET');expect(botNativeContextSchema.parse(value).state).toBe('migration-required');expect(value).not.toHaveProperty('asOfSeq');
});
