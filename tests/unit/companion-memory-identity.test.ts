import { expect, it } from 'vitest';
import { companionMemoryIdentity, companionMemoryIdentitySignature, sameCompanionMemoryIdentity } from '../../src/main/companions/memory-identity';

it('keeps the resident identity and name distinct from the application and other residents', () => {
  const identity = companionMemoryIdentity({ id: 'little-fish', name: '小肥鱼' });
  expect(identity).toEqual({ version: 2, companionId: 'little-fish', name: '小肥鱼', agentName: '小肥鱼' });
  expect(companionMemoryIdentitySignature(identity)).not.toBe(companionMemoryIdentitySignature(companionMemoryIdentity({ id: 'other-fish', name: '小肥鱼' })));
  expect(sameCompanionMemoryIdentity(undefined, identity)).toBe(false);
  expect(sameCompanionMemoryIdentity(companionMemoryIdentity({ id: 'little-fish', name: '小鱼的新名字' }), identity)).toBe(false);
});

it('keeps public names as data while excluding file and RAG marker delimiters from native author aliases', () => {
  const identity = companionMemoryIdentity({ id: 'resident', name: '小鱼/资料\n[[其他日记本]]' });
  expect(identity.name).toBe('小鱼/资料 [[其他日记本]]');
  expect(Array.from('/[]\r\n').some(character => identity.agentName.includes(character))).toBe(false);
  expect(identity.agentName).toContain('小鱼');
});
