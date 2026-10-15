import type { DshLauncherState } from './dsh-launcher';

export function runtimeReferences(state: Pick<DshLauncherState, 'instances' | 'snapshots' | 'packs' | 'tasks'>, runtimeId: string): Array<{ kind: 'instance' | 'snapshot' | 'pack' | 'task'; name: string }> {
  return [
    ...state.instances.filter(item => item.runtimeId === runtimeId).map(item => ({ kind: 'instance' as const, name: item.name })),
    ...state.snapshots.filter(item => item.runtimeId === runtimeId).map(item => ({ kind: 'snapshot' as const, name: item.name })),
    ...state.packs.filter(item => item.runtimeId === runtimeId).map(item => ({ kind: 'pack' as const, name: item.name })),
    ...(state.tasks ?? []).filter(item => item.runtimeId === runtimeId && item.status === 'running').map(item => ({ kind: 'task' as const, name: item.title })),
  ];
}
