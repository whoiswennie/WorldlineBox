import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { companionProcedureStatusCommandSchema, companionProcedureStatusResult, type CompanionProcedureStatusReferences } from '../../shared/companion-procedure-status';
import { memoCompanionExecutionWitnesses, withCompanionExecutionValidation } from './source-execution-evidence';
import { CompanionValidationUnavailableError } from './validation-unavailable';

type Request = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
/** Current annotations use their own finite SQL witness. Body/file evidence is
 * still supplied by the unchanged canonical recall and execution-source gates. */
export function readCompanionProcedureStatuses(input: {
  scope: { companionId: string; conversationId: string; beforeSequence?: number };
  references: CompanionProcedureStatusReferences; identity: object; request: Request; requestFresh: Request;
}) {
  return withCompanionExecutionValidation(async () => {
    const command = companionProcedureStatusCommandSchema.parse({ type: 'memory.procedures.status', ...input.scope, references: input.references });
    const result = companionProcedureStatusResult(command, await input.request(command));
    if (!result) throw new CompanionValidationUnavailableError('方法验证状态未返回准确的当前作用域与修订凭证。');
    const initial = new Map(result.memoryProcedureStatuses.map(status => {
      const header = result.memoryDescriptors.find(header => header.id === status.memoryId)!;
      // Annotation-only versions/index acknowledgement are not body changes.
      const { version: _version, status: _indexStatus, ...authority } = header; void _version; void _indexStatus;
      const reference = { id: status.memoryId, contentRevision: status.contentRevision };
      return [JSON.stringify({ ...command, references: [reference] }), { status, authority }];
    }));
    if (initial.size) await memoCompanionExecutionWitnesses([...initial.keys()], { identity: input.identity,
      scope: 'procedure-status', phase: 'sql-authority', revision: () => 0,
      read: async keys => new Map(keys.map(key => [key, initial.get(key)!])), verify: async entries => {
        const groups = new Map<string, typeof entries[number][]>();
        for (const entry of entries) {
          const { references: _references, ...scope } = companionProcedureStatusCommandSchema.parse(JSON.parse(entry.key)); void _references;
          const key = JSON.stringify(scope), group = groups.get(key) ?? []; group.push(entry); groups.set(key, group);
        }
        for (const [key, group] of groups) for (let offset = 0; offset < group.length; offset += 100) {
          const selected = group.slice(offset, offset + 100), expected = companionProcedureStatusCommandSchema.parse({ ...JSON.parse(key),
            references: selected.map(entry => ({ id: entry.value.status.memoryId, contentRevision: entry.value.status.contentRevision })) });
          const fresh = companionProcedureStatusResult(expected, await input.requestFresh(expected));
          if (!fresh || selected.some(entry => {
            const status = fresh.memoryProcedureStatuses.find(status => status.memoryId === entry.value.status.memoryId);
            const header = fresh.memoryDescriptors.find(header => header.id === entry.value.status.memoryId);
            if (!status || !header) return true;
            const { version: _version, status: _indexStatus, ...authority } = header; void _version; void _indexStatus;
            return JSON.stringify(status) !== JSON.stringify(entry.value.status) || JSON.stringify(authority) !== JSON.stringify(entry.value.authority);
          })) throw new CompanionValidationUnavailableError('方法验证状态或实际来源在最终核验时变化。');
        }
      } });
    return result.memoryProcedureStatuses;
  });
}
