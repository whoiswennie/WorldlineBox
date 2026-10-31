/* eslint-disable @typescript-eslint/no-explicit-any -- Read-only benchmark instrumentation. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export function createAutomaticRecallAudit() {
  type Task = { sourceId: string; ownerId: string; taskHash: string; label?: string; phase: string; calls: number; passiveSearches: number; activeSearches: number };
  const tasks = new Map<string, Task>(), scope = new AsyncLocalStorage<Task>();
  const providerTools = new Set<string>();
  let providerRequests = 0, memoryDeclarations = 0, providerInspectionMs = 0, unscopedPassiveSearches = 0;
  function provider(body: string): string[] {
    const begun = performance.now(), names = new Set<string>();
    const visit = (value: any) => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      if (typeof value.name === 'string') names.add(value.name);
      for (const key of ['function', 'functionDeclarations', 'function_declarations', 'functions']) if (value[key]) visit(value[key]);
    };
    const value = JSON.parse(body);
    visit(value.tools); visit(value.functions);
    providerRequests++;
    for (const name of names) { providerTools.add(name); if (/^memory(?:[._]|$)/u.test(name)) memoryDeclarations++; }
    providerInspectionMs += performance.now() - begun;
    return [...names].sort();
  }
  function install(memory: any, context: { phase(): string; label(sourceId: string): string | undefined }) {
    const recall = memory.recall.bind(memory), search = memory.searchScoped.bind(memory);
    memory.recall = (input: any) => {
      const key = JSON.stringify([input.companion.id, input.conversation.id, input.currentMessage.id]);
      let task = tasks.get(key);
      if (!task) { task = { sourceId: input.currentMessage.id, ownerId: input.companion.id,
        taskHash: createHash('sha256').update(key).digest('hex'), label: context.label(input.currentMessage.id), phase: context.phase(), calls: 0, passiveSearches: 0, activeSearches: 0 }; tasks.set(key, task); }
      task.calls++;
      return scope.run(task, () => recall(input));
    };
    memory.searchScoped = (...args: any[]) => {
      const task = scope.getStore();
      if (task) { if (args[1] === 'passive') task.passiveSearches++; else task.activeSearches++; }
      else if (args[1] === 'passive') unscopedPassiveSearches++;
      return search(...args);
    };
  }
  function snapshot(dispatched: Array<{ sourceId: string; ownerId?: string; label: string }>) {
    const rows = [...tasks.values()];
    const targets = dispatched.map(target => {
      const matches = rows.filter(task => task.sourceId === target.sourceId && (!target.ownerId || task.ownerId === target.ownerId));
      return { label: target.label, calls: matches.reduce((count, task) => count + task.calls, 0),
        passiveSearches: matches.reduce((count, task) => count + task.passiveSearches, 0) };
    });
    return { providerRequests, actualToolNames: [...providerTools].sort(), memoryDeclarations, providerInspectionMs,
      hostTasks: rows.map(task => ({ taskHash: task.taskHash, label: task.label, phase: task.phase,
        calls: task.calls, passiveSearches: task.passiveSearches, activeSearches: task.activeSearches })), unscopedPassiveSearches, targets,
      everyDispatchedTaskPreparedOnce: targets.every(task => task.calls === 1 && task.passiveSearches === 1),
      noTaskPreparedTwice: rows.every(task => task.calls <= 1 && task.passiveSearches <= 1) };
  }
  return { provider, install, snapshot };
}
