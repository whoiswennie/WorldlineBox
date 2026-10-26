/* global require, process, setTimeout */
'use strict';

const { VcpMemoryRuntime } = require('./runtime.cjs');
const runtime = new VcpMemoryRuntime();
const parentPort = process.parentPort;
const send = message => parentPort ? parentPort.postMessage(message) : process.send?.(message);
let tail = Promise.resolve();
function receive(message) {
  const request = parentPort ? message.data : message;
  tail = tail.then(async () => {
    if (!request || typeof request.requestId !== 'string' || !request.command) return;
    const { requestId, command } = request;
    try {
      if (command.ownerPrompts && runtime.peripherals) runtime.peripherals.setOwnerPrompts(command.ownerPrompts);
      let value;
      switch (command.type) {
        case 'initialize': value = await runtime.initialize(command.configuration); break;
        case 'remember': value = await runtime.remember(command.note); break;
        case 'replace': value = await runtime.replace(command.notes); break;
        case 'prepare': value = await runtime.prepare(); break;
        case 'search': value = await runtime.search(command); break;
        case 'read': value = await runtime.read(command.id); break;
        case 'list': value = await runtime.list(); break;
        case 'forget': value = await runtime.forget(command.id); break;
        case 'plugin': value = await runtime.peripherals.call(command.plugin, command.arguments); break;
        case 'preprocess': value = await runtime.peripherals.preprocess(command.messages, command.clock, command.automaticDecay); break;
        case 'prepare-recall': value = await runtime.peripherals.prepareRecall(command.messages, command.clock, command.automaticDecay); break;
        case 'dream-wave': value = await require('./dream-runtime.cjs').generateDreamWave(runtime, command.request); break;
        case 'timeline': value = await runtime.peripherals.timeline(command.request); break;
        case 'capabilities': value = await runtime.peripherals.capabilities(); break;
        case 'export-notes': value = await runtime.exportNotes(); break;
        case 'export-timelines': value = await runtime.peripherals.exportTimelines(command.sourceRevision); break;
        case 'import-timelines': value = await runtime.peripherals.importTimelines(command.sourceRevision, command.artifacts); break;
        case 'close': await runtime.close(); value = { closed: true }; break;
        default: throw Object.assign(new Error('Unknown VCP memory operation.'), { code: 'VCP_MEMORY_INVALID_COMMAND' });
      }
      send({ requestId, ok: true, value });
      if (command.type === 'close') setTimeout(() => process.exit(0), 10);
    } catch (error) {
      send({ requestId, ok: false, error: { message: String(error.message || error), code: String(error.code || 'VCP_MEMORY_ERROR') } });
    }
  }).catch(error => send({ type: 'fatal', error: { message: String(error.message || error) } }));
}
if (parentPort) parentPort.on('message', receive);
else process.on('message', receive);
send({ type: 'booted' });
