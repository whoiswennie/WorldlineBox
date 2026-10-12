async function setup(worldlinebox) {
  worldlinebox.hooks.onWill('asset.trash', async () => ({
    action: 'block',
    code: 'DEMO_BLOCK',
    message: 'Hook blocking probe refused trash.',
  }));
  await worldlinebox.storage.set('hook-blocking-probe', { armed: true });
}

async function dispose() {}

void setup;
void dispose;
