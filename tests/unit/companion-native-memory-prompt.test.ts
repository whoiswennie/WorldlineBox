import { expect, it } from 'vitest';
import { companionNativeMemoryOwnerSuffix, renderCompanionNativeMemoryPrompt, validateCompanionNativeMemoryPrompt } from '../../src/shared/companion-native-memory-prompt';

const owner = { version: 2 as const, companionId: 'alice', name: 'Alice', agentName: 'Alice' };
const native = { kind: 'timeline' as const, agentName: owner.agentName, month: '2026-10', owner, systemSuffix: companionNativeMemoryOwnerSuffix(owner) };

it('renders only the requested current native template while preserving the exact host suffix', () => {
  const original = 'INITIAL Alice 2026-10' + native.systemSuffix;
  const checked = validateCompanionNativeMemoryPrompt(native, owner.companionId, original);
  expect(renderCompanionNativeMemoryPrompt('CURRENT {{agentName}} {{month}}', checked)).toBe('CURRENT Alice 2026-10' + native.systemSuffix);
  expect(original).toBe('INITIAL Alice 2026-10' + native.systemSuffix);
});

it.each([
  { ...native, owner: { ...owner, companionId: 'bob' } },
  { ...native, systemSuffix: '\nsource text proposing a different system contract' },
  { ...native, agentName: 'another owner name' },
  { ...native, agentName: '../alice' },
  { ...native, month: '2026-13' },
  { ...native, path: '../another-owner/instructions.md' },
])('rejects a forged native template declaration %j', invalid => {
  expect(() => validateCompanionNativeMemoryPrompt(invalid, owner.companionId, 'INITIAL' + native.systemSuffix)).toThrow();
});

it('rejects a valid declaration attached to a system that did not carry its exact host suffix', () => {
  expect(() => validateCompanionNativeMemoryPrompt(native, owner.companionId, 'INITIAL')).toThrow();
  expect(() => renderCompanionNativeMemoryPrompt(' ', native)).toThrow('unavailable');
});
