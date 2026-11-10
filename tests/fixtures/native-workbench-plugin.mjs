// Installed only in a fresh test-owned DSH profile. Exercise the same public
// Session controller used by the Workbench, without a product debug endpoint.
/* global AbortSignal */
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
export const inject = ['sessionController', 'agents', 'sessions', 'agentDefaultModel'];
const addressFile = '__ADDRESS_FILE__';
export async function apply(ctx) {
  let nativeDefault;
  const original = ctx.agentDefaultModel.currentSelection.bind(ctx.agentDefaultModel);
  ctx.agentDefaultModel.currentSelection = () => nativeDefault ?? { provider: 'unconfigured-fixture-default', model: 'fixture' };
  const server = http.createServer((request, response) => {
    void (async () => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      if (input.action === 'prompt') {
        await ctx.sessionController.prompt({ requestId: input.id, sessionId: input.sessionId, mode: 'queue', content: [{ type: 'text', text: input.text }] }, AbortSignal.timeout(10000));
        return { accepted: true };
      }
      const found = await ctx.sessionController.resolveAgent(input.sessionId); if (found.error) throw found.error;
      const agent = found.agent;
      if (input.action === 'default') nativeDefault = agent.model.current();
      if (input.action === 'select') agent.model.select(input.selection);
      if (input.action === 'wait') { await agent.whenIdle(); await ctx.sessions.flush(agent.session); }
      return { status: agent.status, model: agent.model.current(), events: agent.session.snapshotEvents() };
    })().then(value => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value)), error =>
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error.message ?? error) })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(addressFile, JSON.stringify({ port: server.address().port }));
  ctx.effect(() => async () => {
    ctx.agentDefaultModel.currentSelection = original;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
}
