import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { atomicJson } from './files';
import { rm } from './disk';

/** Local launcher integrity service. It starts no Harness Host or WebUI. */
export class CliAdmission {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  constructor(private readonly root: string, private readonly verify: (id: string, digest: string) => Promise<void>) {}
  async start(): Promise<void> {
    const token = randomBytes(32).toString('hex');
    const server = createServer(socket => {
      this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); socket.setTimeout(360000, () => socket.destroy());
      let input = ''; let handled = false;
      socket.on('data', bytes => {
        if (handled) return; input += bytes.toString();
        if (input.length > 4096) { socket.destroy(); return; }
        if (!input.includes('\n')) return; handled = true;
        void (async () => {
          try {
            const request = JSON.parse(input);
            if (request.token !== token || !/^runtime-[a-f0-9]{24}$/.test(request.runtimeId) || !/^[a-f0-9]{64}$/.test(request.digest)) throw new Error('Invalid admission identity.');
            await this.verify(request.runtimeId, request.digest); socket.end(JSON.stringify({ ok: true }) + '\n');
          } catch { socket.end(JSON.stringify({ ok: false }) + '\n'); }
        })();
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.server = server; server.unref();
    await atomicJson(path.join(this.root, 'cli', 'admission.json'), { port: (server.address() as { port: number }).port, token });
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    await rm(path.join(this.root, 'cli', 'admission.json'), { force: true });
  }
}
