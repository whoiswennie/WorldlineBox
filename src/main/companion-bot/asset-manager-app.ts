import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { EmbeddedMcpServer } from '../embedded-mcp-server';
import type { CompanionAppScope, CompanionAssetArguments, BotAppConnection } from '../../shared/companion-apps';

/** Uses the existing authenticated MCP HTTP protocol and its permission broker. */
export class BotAssetManagerApp {
  private readonly sessions = new Map<string, { client: Client; transport: StreamableHTTPClientTransport; endpoint: string; generation: string; active: number; timer?: ReturnType<typeof setTimeout> }>();
  private readonly connecting = new Map<string, Promise<void>>();
  private readonly shutdown = new AbortController();
  constructor(private readonly server: () => EmbeddedMcpServer | undefined) {}

  private async session<T>(scope: CompanionAppScope, activate: boolean, signal: AbortSignal, operation: (client: Client) => Promise<T>): Promise<T> {
    signal.throwIfAborted(); this.shutdown.signal.throwIfAborted();
    const server = this.server();
    if (!server) throw new Error('资产管理器 MCP 服务不可用，请检查软件的 MCP 设置。');
    const connection = await server.companionConnection(scope.companionId, scope.companionName, activate);
    signal.throwIfAborted();
    const key = JSON.stringify([scope.companionId, scope.conversationId, scope.topicId ?? 'connect']);
    const current = this.sessions.get(key);
    if (current && (current.endpoint !== connection.endpoint || current.generation !== connection.generation || !current.client.transport)) await this.retire(key);
    if (!this.sessions.has(key)) {
      let pending = this.connecting.get(key);
      if (!pending) {
        pending = (async () => {
          if (this.sessions.size + this.connecting.size >= 16) {
            const idle = [...this.sessions].find(([, entry]) => !entry.active);
            if (!idle) throw new Error('资产管理器连接繁忙，请稍后重试。');
            await this.retire(idle[0]);
          }
          const client = new Client({ name: 'WorldlineBox 伙伴 · ' + scope.companionName.slice(0, 80), version: '1.0.0' });
          const transport = new StreamableHTTPClientTransport(new URL(connection.endpoint), { requestInit: { headers: { Authorization: 'Bearer ' + connection.token } } });
          try {
            await client.connect(transport, { signal: this.shutdown.signal, timeout: 15_000 });
            this.shutdown.signal.throwIfAborted();
            this.sessions.set(key, { client, transport, endpoint: connection.endpoint, generation: connection.generation, active: 0 });
          } catch (error) { await client.close().catch(() => undefined); throw error; }
        })().finally(() => this.connecting.delete(key));
        this.connecting.set(key, pending);
      }
      await pending;
    }
    const entry = this.sessions.get(key)!;
    clearTimeout(entry.timer); entry.active++;
    try {
      signal.throwIfAborted();
      return await operation(entry.client);
    } finally {
      entry.active--;
      if (!entry.active) { entry.timer = setTimeout(() => { void this.retire(key); }, 120_000); entry.timer.unref(); }
    }
  }

  private async retire(key: string): Promise<void> {
    const entry = this.sessions.get(key); if (!entry) return;
    this.sessions.delete(key); clearTimeout(entry.timer);
    await entry.transport.terminateSession().catch(() => undefined);
    await entry.client.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled(this.connecting.values());
    await Promise.all([...this.sessions.keys()].map(key => this.retire(key)));
  }

  async connect(scope: CompanionAppScope, signal: AbortSignal): Promise<BotAppConnection> {
    return this.session(scope, true, signal, async client => {
      const libraries = await client.callTool({ name: 'worldlinebox_library_list_open', arguments: {} }, undefined, { signal });
      if (libraries.isError) throw new Error('连接已建立，但读取资产库失败：' + JSON.stringify(libraries.content).slice(0, 1000));
      const data = libraries.structuredContent as { result?: { libraries?: unknown[] }; libraries?: unknown[] } | undefined;
      return { id: 'asset-manager', libraryCount: (data?.result?.libraries ?? data?.libraries ?? []).length };
    });
  }

  async execute(scope: CompanionAppScope, input: CompanionAssetArguments, signal: AbortSignal): Promise<unknown> {
    return this.session(scope, false, signal, async client => {
      if (input.action === 'call') return client.callTool({ name: input.name, arguments: input.arguments }, undefined, { signal, timeout: 10 * 60_000 });
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do { const page = await client.listTools(cursor ? { cursor } : {}, { signal }); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
      if (input.action === 'describe') return { tools: input.names.map(name => { const tool = tools.find(tool => tool.name === name); if (!tool) throw new Error('未找到 MCP 工具：' + name); return tool; }) };
      const query = input.query.toLocaleLowerCase();
      const matches = tools.filter(tool => (tool.name + ' ' + (tool.description ?? '')).toLocaleLowerCase().includes(query));
      return { tools: matches.slice(input.offset, input.offset + input.limit).map(({ name, description, annotations }) => ({ name, description, annotations })), total: matches.length,
        nextOffset: input.offset + input.limit < matches.length ? input.offset + input.limit : undefined };
    });
  }
}
