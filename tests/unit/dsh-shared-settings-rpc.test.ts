import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connectNativeSettings } from '../../src/main/dsh/shared-settings-rpc';

let server: Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });

it('uses authenticated native unary RPC and never includes secret diagnostics in thrown errors', async () => {
  let validEnvelope = false, validAuthorization = false;
  server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/?private-fixture-token') {
      response.writeHead(303, { location: './', 'set-cookie': 'fixtureAuth=private-fixture-cookie; HttpOnly; SameSite=Strict' }).end(); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { rpcId: string; method: string; type: string; payload: { args: Record<string, unknown> } };
    validEnvelope = body.type === 'client-request' && request.url === `/api/${body.method}` && typeof body.rpcId === 'string';
    validAuthorization = request.headers.cookie === 'fixtureAuth=private-fixture-cookie' && request.headers.origin?.startsWith('http://127.0.0.1:') === true;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: body.method === 'settings/describe'
      ? { ok: true, value: { namespaces: [{ ns: 'llm-pi-ai', user: { providers: {} }, revision: 0 }] } }
      : { ok: false, error: { code: 'settings/conflict', message: 'fixture-private-key-must-not-be-propagated' } } }));
  });
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture listener.');
  const transport = await connectNativeSettings(`http://127.0.0.1:${address.port}/?private-fixture-token`);
  try {
    expect((await transport.describe())[0]?.ns).toBe('llm-pi-ai');
    let diagnostic = '';
    try { await transport.mutate('llm-pi-ai', [{ op: 'set', path: ['providers'], value: {} }], 0); }
    catch (error) { diagnostic = error instanceof Error ? error.message : ''; }
    expect(diagnostic).toContain('settings/conflict');
    expect(diagnostic.includes('fixture-private-key')).toBe(false);
    expect(validEnvelope).toBe(true); expect(validAuthorization).toBe(true);
  } finally { transport.close(); }
});

it('rejects external or ambiguous host URLs before any credential-bearing fetch', async () => {
  for (const url of ['https://example.com/?token', 'http://localhost:1234/?token', 'http://127.0.0.1:1234/api?token']) await expect(connectNativeSettings(url)).rejects.toThrow('invalid-loopback-url');
});
