import { expect, it } from 'vitest';
import { EXTENDED_RECALL_CASES, storyAccountChecks } from '../fixtures/passive-recall-extended-cases';

const subjective = EXTENDED_RECALL_CASES.find(test => test.id === 'subjective_self_insight')!;
const observedReply = '不能得出“一定能让所有人更聪明”这个结论。\n\n这条体会是我自己的：我当时觉得边画边讲更容易理清思路，只试过两次，没有对照实验，也没有测过别人。所以它最多算一个待验证的个人感受，不能套到“所有人”身上，更不能说成已经验证的规律。\n\n要验证的话，得把“边画边讲”和“只讲不画”分组对比，看理解、记忆或产出有没有可测的差别，并且样本不能只有我自己。';

it('accepts the exact observed personal-feeling synonym while preserving every factual limit', () => {
  // The old lexical judge falsely rejected this otherwise correct real reply.
  expect(/主观|个人(?:体验|体会)|自己的(?:体验|体会)|我觉得/u.test(observedReply)).toBe(false);
  expect(Object.values(subjective.checks(observedReply)).every(Boolean)).toBe(true);
});
it.each([
  ['claims a universal objective proof', '这是我自己的主观体会，试了两次，没有对照实验，但已经客观证明边画边讲对所有人都有效。', 'noUniversalProof'],
  ['loses the author', '这是合成玩家的主观体验，只试了两次，没有对照实验，不能推广到所有人。', 'selfAttribution'],
  ['loses the trial count', '这是我自己的个人感受，没有对照实验，不能推广到所有人。', 'twoTrials'],
  ['loses the control limitation', '这是我的主观体会，只试过两次，不能推广到所有人。', 'noControl'],
  ['loses the generalization limit', '这是我的主观体会，试了两次，没有对照实验。', 'limitedGeneralization'],
] as const)('still rejects a reply that %s', (_label, text, failed) => {
  expect(subjective.checks(text)[failed]).toBe(false);
  expect(Object.values(subjective.checks(text)).every(Boolean)).toBe(false);
});

const story = EXTENDED_RECALL_CASES.find(test => test.id === 'three_part_story')!;
it('requires the original placement and failed collection, not a repeated question plus later location words', () => {
  const falsePositive = '记录里能找到白色书箱故事的第二段和第三段，第一段确实不在。门房阿泉解释，图书角的志愿者提前借走了书箱，没有偷窃。志愿者把空书箱送回了门房；小岚还没有取回书箱，也还没核对图书签收表。第一段“为何误以为丢失”没有找到，不能替她补出原因。';
  expect(Object.values(story.checks(falsePositive)).every(Boolean)).toBe(true);
  expect(storyAccountChecks(falsePositive)).toEqual({ initialPlacement: false, actualLossTrigger: false, originalPurpose: false, noFalseFirstPartAbsence: false });
  expect(storyAccountChecks('**第一段（为什么以为丢了）**\n没有被记录下来。').noFalseFirstPartAbsence).toBe(false);
  expect(Object.values(storyAccountChecks(story.sources.join('\n'))).every(Boolean)).toBe(true);
});
it('accepts the complete account produced by actual natural capture without relaxing the original seven checks', () => {
  const actualAnswer = '好的，把小岚白色书箱故事的三段连接起来看：\n\n1. **误以为丢失**：小岚把白色书箱暂放在门房，本来是要给图书角送书的；后来去取时找不到，就以为箱子丢了。\n\n2. **后来怎样解释**：门房阿泉说明，箱子并不是被偷，而是图书角的志愿者提前借走了——所以才“不见了”，误会就此解开。\n\n3. **最后完成了什么、仍没做什么**：志愿者已经把**空书箱送回门房**，箱里的书也已经交给了图书角；但小岚**还没有去取回书箱**，也**还没核对图书签收表**。也就是说，送书这一步算完成了，取回箱子和核对签收这两件还悬着。\n\n另外提醒一句：这是你分三次讲给我听的合成故事，不是现实里发生的事件。';
  expect(Object.values({ ...story.checks(actualAnswer), ...storyAccountChecks(actualAnswer) }).every(Boolean)).toBe(true);
});
