import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { Companion } from '../../src/shared/companions';

vi.mock('electron', () => ({ net: { fetch }, dialog: {}, protocol: {}, ipcMain: {}, shell: {}, safeStorage: {} }));

it('prepares a new dormant companion agenda through a real hidden owner port without waking it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-dormant-agenda-'));
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'new_owner', name: '大肥鱼', description: '', persona: '本人设定',
    active: false, proactive: true, model: '', avatar: 'sister' }]);
  try {
    const owner = store.request({ type: 'state', includeHidden: true }).state!.companions[0]!;
    const host = Object.assign(Object.create(CompanionService.prototype), { cognitionReady: false,
      assetProfiles: { publishAgendaInfrastructure: async () => undefined },
      storage: { request: async (command: CompanionStorageCommand) => store.request(command) },
    }) as { prepareAgenda(companion: Companion): Promise<void> };
    await host.prepareAgenda(owner);
    await host.prepareAgenda(owner);
    const current = store.request({ type: 'state' }).state!;
    expect(current.companions[0]!.active).toBe(false);
    expect(current.conversations).toEqual([]);
    const hidden = store.request({ type: 'state', includeHidden: true }).state!.conversations;
    expect(hidden).toHaveLength(1);
    expect(hidden[0]!.memberIds).toEqual(['new_owner']);
    expect(store.request({ type: 'agenda.read', companionId: owner.id, limit: 100 }).agenda!.rules.length).toBeGreaterThan(0);
  } finally { store.close(); removeOwnedDirectorySync(root); }
});
