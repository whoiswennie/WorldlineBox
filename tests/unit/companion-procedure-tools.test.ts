import { expect, it } from 'vitest';
import { COMPANION_MEMORY_CAPABILITY_TOOL, normalizeCompanionCapabilityCall } from '../../src/shared/companion-capability-tools';
import { companionMemoryToolArgumentsSchemas } from '../../src/shared/companion-memory-tool';

const procedure = { applicability: '生成本地 UTF-8 报告时。', steps: ['核对实际输入，再生成报告并检查交付。'], limitations: ['不保证报告结论适用于其他输入。'],
  verification: { kind: 'artifact_delivery', artifactRequirements: [{ path: 'report.md', minBytes: 10 }] } };
const candidate = { content: '核对输入后生成报告并检查产物。', sourceMessageIds: ['actual_source'], evidence: [{ sourceMessageId: 'actual_source', quote: '核对输入' }], procedure };

it('publishes the same bounded procedure proposal in native tool schema and actual argument parsing', () => {
  const native = JSON.stringify(COMPANION_MEMORY_CAPABILITY_TOOL.parameters);
  expect(native).toContain('procedure'); expect(native).toContain('artifactRequirements'); expect(native).not.toContain('observe-action');
  const call = normalizeCompanionCapabilityCall({ id: 'call_one', name: 'memory', arguments: JSON.stringify({ action: 'record', candidate }) });
  expect(call.name).toBe('memory.record'); expect(JSON.parse(call.arguments).candidate.procedure).toEqual(procedure);
});

it('rejects model-supplied practice validation and has no native host-observation capability', () => {
  expect(() => companionMemoryToolArgumentsSchemas['memory.record'].parse({ candidate: { ...candidate, procedure: { ...procedure,
    validation: { state: 'validated', successes: 999, failures: 0, evidence: [] } } } })).toThrow();
  expect(() => normalizeCompanionCapabilityCall({ id: 'call_two', name: 'memory', arguments: JSON.stringify({ action: 'procedure.observe-action', actionId: 'pretend_action' }) })).toThrow();
});
