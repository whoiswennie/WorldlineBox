async function setup(worldlinebox) {
  worldlinebox.commands.register('probe.write', async () => {
    await worldlinebox.storage.set('iframe-command', {
      invoked: true,
      source: 'workspace-iframe',
    });
  });
}

async function dispose() {}

void setup;
void dispose;
