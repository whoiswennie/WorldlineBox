async function setup(worldlinebox) {
  await worldlinebox.assets.search({ query: null, limit: 1 });
  const previous = await worldlinebox.storage.get('host-probe');
  await worldlinebox.storage.set('host-probe', { activated: true, source: 'standard-host-probe', previous });
}

async function dispose() {}

void setup;
void dispose;
