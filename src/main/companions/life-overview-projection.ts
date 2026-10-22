import type { Companion } from '../../shared/companions';
import type { CompanionMemoryLifePlan } from '../../shared/companion-life-plan';
import type { CompanionMemoryProcessing } from '../../shared/companion-memory-processing';
import type { CompanionLifeOverview, CompanionLifeOverviewContext } from '../../shared/companion-life-overview';

/** Combine already bounded owner snapshots; this never asks the model to plan work. */
export function projectCompanionLifeOverview(input: { companion: Pick<Companion, 'id' | 'name' | 'active'>;
  overview: CompanionLifeOverviewContext; memoryLifePlan: CompanionMemoryLifePlan; memoryProcessing?: CompanionMemoryProcessing }): CompanionLifeOverview {
  const { companion, overview, memoryLifePlan, memoryProcessing } = input;
  if (overview.companionId !== companion.id || memoryLifePlan.companionId !== companion.id
    || memoryProcessing && memoryProcessing.companionId !== companion.id) throw new Error('生活总览不属于当前伙伴。');
  return { ...overview, companion: { id: companion.id, name: companion.name, active: companion.active !== false }, memoryLifePlan,
    ...(memoryProcessing ? { memoryProcessing } : {}) };
}
