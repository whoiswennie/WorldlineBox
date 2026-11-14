import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const bridgeJson = process.argv[2];
if (!bridgeJson || !path.isAbsolute(bridgeJson)) throw new Error('Expected an absolute path to Cabin World data/bridge.json.');
const worldRoot = path.resolve(path.dirname(bridgeJson), '..');
const { tools: definitions } = JSON.parse(await readFile(process.argv[3] ?? path.join(worldRoot, 'bridge', 'openai-tools.json'), 'utf8'));
const toolNames = ['cabin_status', 'cabin_look', 'cabin_go', 'cabin_use', 'cabin_buy', 'cabin_eat', 'cabin_stop'];
const tools = toolNames.map(name => {
  const definition = definitions.find(tool => tool.type === 'function' && tool.function?.name === name)?.function;
  if (!definition) throw new Error(`Cabin World tool definition is missing: ${name}`);
  return { name, description: definition.description, inputSchema: definition.parameters };
});
const taskTool = 'cabin_task_status';
tools.push({
  name: taskTool,
  description: '查询小屋世界返回的 taskId。只有 status 为 done 才能确认动作完成。running 时继续查询，避免重发动作。',
  inputSchema: {
    type: 'object',
    properties: { taskId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,128}$' } },
    required: ['taskId'],
    additionalProperties: false,
  },
});

const validator = new AjvJsonSchemaValidator();
const validators = new Map(tools.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));
const actions = new Set(['cabin_go', 'cabin_use', 'cabin_buy', 'cabin_eat']);

async function bridgeRequest(route, body, signal) {
  let info, endpoint;
  try {
    info = JSON.parse(await readFile(bridgeJson, { encoding: 'utf8', signal }));
    endpoint = new URL(info.url);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
      || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
      || typeof info.token !== 'string' || !/^[a-f0-9]{48}$/.test(info.token)) throw new Error('Invalid bridge metadata');
  } catch {
    signal.throwIfAborted();
    throw new Error('无法读取有效的小屋世界连接信息。请用 start.cmd 启动小屋世界并检查插件配置。');
  }

  const timeout = AbortSignal.any([signal, AbortSignal.timeout(body ? 50000 : 5000)]);
  try {
    const response = await fetch(new URL(route, endpoint), {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${info.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body && JSON.stringify(body),
      redirect: 'error',
      signal: timeout,
    });
    const result = await response.json();
    return { result, isError: !response.ok || result.ok === false || result.status === 'failed' };
  } catch {
    signal.throwIfAborted();
    throw new Error('小屋世界桥没有返回结果。请确认它在线。如果刚发出了动作，先查询角色状态，再决定是否重试。');
  }
}

function toolResult(result, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, ...(isError ? { isError } : {}) };
}

const server = new Server({ name: 'worldlinebox-cabin-world', version: '1.0.0' }, {
  capabilities: { tools: {} },
  instructions: '小屋世界是伙伴可以操作的像素世界。用 cabin_status 查看角色状态，用 cabin_look 查看当前房间可用的物品和动作。动作返回 running 时用 cabin_task_status 查询原 taskId。只有 done 表示完成。',
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
  const { name, arguments: args = {} } = params;
  const validate = validators.get(name);
  if (!validate) return toolResult({ ok: false, error: '未知的小屋世界工具。' }, true);
  if (!validate(args).valid) return toolResult({ ok: false, error: '参数不符合小屋世界工具的定义。' }, true);
  try {
    const { result, isError } = name === taskTool
      ? await bridgeRequest(`/v1/tasks/${args.taskId}`, undefined, signal)
      : await bridgeRequest('/v1/tool', { name, arguments: actions.has(name) ? { ...args, waitMs: 45000 } : args }, signal);
    return toolResult(result, isError);
  } catch (error) {
    signal.throwIfAborted();
    return toolResult({ ok: false, error: error.message }, true);
  }
});
await server.connect(new StdioServerTransport());
