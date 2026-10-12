async function setup(worldlinebox) {
  worldlinebox.commands.register('probe.write-selection', async (context) => {
    const enabledDemo = await worldlinebox.storage.get('settings.enabled-demo');
    await worldlinebox.storage.set('menu-command', {
      assetId: context.assetIds && context.assetIds[0],
      enabledDemo,
    });
  });
  worldlinebox.commands.register('probe.write-folder', async (context) => {
    await worldlinebox.storage.set('menu-command-folder', {
      folderId: context.folderIds && context.folderIds[0],
    });
  });
  worldlinebox.commands.register('probe.write-collection', async (context) => {
    await worldlinebox.storage.set('menu-command-collection', {
      collectionId: context.collectionIds && context.collectionIds[0],
    });
  });
  worldlinebox.commands.register('probe.write-toolbar', async (context) => {
    await worldlinebox.storage.set('toolbar-command', {
      assetId: context.assetIds && context.assetIds[0],
      assetCount: context.assetIds ? context.assetIds.length : 0,
    });
  });
  worldlinebox.commands.register('probe.write-inspector', async (context) => {
    await worldlinebox.storage.set('inspector-command', {
      assetId: context.assetIds && context.assetIds[0],
      assetCount: context.assetIds ? context.assetIds.length : 0,
    });
  });
  worldlinebox.commands.register('probe.write-viewer', async (context) => {
    await worldlinebox.storage.set('viewer-command', {
      assetId: context.assetIds && context.assetIds[0],
    });
  });
  worldlinebox.commands.register('probe.write-workspace', async (context) => {
    await worldlinebox.storage.set('workspace-command', {
      assetId: context.assetIds && context.assetIds[0],
      assetCount: context.assetIds ? context.assetIds.length : 0,
    });
  });
  worldlinebox.commands.register('probe.write-shortcut', async (context) => {
    await worldlinebox.storage.set('shortcut-command', {
      assetId: context.assetIds && context.assetIds[0],
      assetCount: context.assetIds ? context.assetIds.length : 0,
    });
  });
}

async function dispose() {}

void setup;
void dispose;
