/* global exports */
exports.setup = async function setup(worldlinebox) {
  await worldlinebox.storage.set('host-probe', { activated: true, source: 'unrestricted-settings-probe' });
  worldlinebox.commands.register('probe.write-selection', async (context) => {
    const assetId = Array.isArray(context?.assetIds) ? context.assetIds[0] ?? null : null;
    await worldlinebox.storage.set('menu-command', { assetId });
  });
  worldlinebox.commands.register('probe.nested-selection', async (context) => {
    const assetId = Array.isArray(context?.assetIds) ? context.assetIds[0] ?? null : null;
    await worldlinebox.storage.set('nested-menu-command', { assetId });
  });
};

exports.dispose = async function dispose() {};
