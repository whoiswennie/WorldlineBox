async function setup(worldlinebox) {
  await worldlinebox.storage.set('setup-started', true);
  worldlinebox.jobs.registerHandler('tick', async (payload) => {
    const storedAttempts = await worldlinebox.storage.get('job-attempts');
    const attempts = Number(storedAttempts ?? 0);
    await worldlinebox.storage.set('job-attempts', attempts + 1);
    // The first execution intentionally remains in flight. The E2E test kills
    // the entire application, then verifies that the unfinished job remains
    // interrupted and that a later explicit command can enqueue a new job.
    if (attempts === 0) {
      await new Promise(() => {});
    }
    await worldlinebox.storage.set('job-tick', payload);
  });
  worldlinebox.commands.register('start', async () => {
    await enqueueJob(worldlinebox);
  });
}

async function enqueueJob(worldlinebox) {
  await worldlinebox.jobs.enqueue({
    handlerId: 'tick',
    payload: { tick: 1 },
  });
}

async function dispose() {}

void setup;
void dispose;
