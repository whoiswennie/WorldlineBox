import type { DshLauncherState } from './dsh-launcher';

export function runtimeReferences(state: Pick<DshLauncherState, 'instances' | 'snapshots' | 'packs'>, runtimeId: string): Array<{ kind: 'instance' | 'snapshot' | 'pack'; name: string }> {
  return [
    ...state.instances.filter(item => item.runtimeId === runtimeId).map(item => ({ kind: 'instance' as const, name: item.name })),
    ...state.snapshots.filter(item => item.runtimeId === runtimeId).map(item => ({ kind: 'snapshot' as const, name: item.name })),
    ...state.packs.filter(item => item.runtimeId === runtimeId).map(item => ({ kind: 'pack' as const, name: item.name })),
  ];
}
