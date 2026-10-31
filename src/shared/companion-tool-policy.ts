import { z } from 'zod';
import { COMPANION_SUBMIT_RESULT_TOOL } from './companion-final-proposal';

/** A sent message freezes these switches. They narrow the host's existing
 * permissions; enabling a switch never creates an observation/file grant. */
export const companionToolPolicySchema = z.strictObject({
  dsh: z.boolean(), browser: z.boolean(), memory: z.boolean(), world: z.boolean(),
  social: z.boolean(), planning: z.boolean(), observation: z.boolean(), files: z.boolean(),
});
export type CompanionToolPolicy = z.infer<typeof companionToolPolicySchema>;
export const DEFAULT_COMPANION_TOOL_POLICY: Readonly<CompanionToolPolicy> = Object.freeze({
  dsh: true, browser: false, memory: true, world: true, social: true, planning: true, observation: true, files: true,
});
export function normalizeCompanionToolPolicy(input?: CompanionToolPolicy): CompanionToolPolicy {
  return input === undefined ? { ...DEFAULT_COMPANION_TOOL_POLICY } : companionToolPolicySchema.parse(input);
}
export function intersectCompanionToolPolicies(policies: readonly (CompanionToolPolicy | undefined)[]): CompanionToolPolicy {
  const [first, ...rest] = policies.map(normalizeCompanionToolPolicy);
  const result = first ?? normalizeCompanionToolPolicy();
  for (const policy of rest) for (const key of Object.keys(result) as Array<keyof CompanionToolPolicy>) result[key] &&= policy[key];
  return result;
}

const socialActions = new Set(['social', 'message', 'introduce', 'create_group', 'collaborate', 'share_entrance', 'visit', 'respond']);
function argumentsObject(value?: string | object): Record<string, unknown> {
  try { const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}
/** Accepts both public umbrella names and the host's normalized aliases. */
export function companionToolPolicyAllows(policy: CompanionToolPolicy, call: { name: string; arguments?: string | object }): boolean {
  const args = argumentsObject(call.arguments);
  // Host delivery controls do not execute an action or grant a capability.
  // They remain available only when the caller registered their real schema.
  if (call.name === 'wait' || call.name === COMPANION_SUBMIT_RESULT_TOOL) return true;
  // Long-term recall belongs to the host's initial task preparation. Keep the
  // persisted memory switch readable for old tasks and internal jobs only.
  if (call.name === 'memory' || call.name.startsWith('memory.') || call.name === 'experience') return false;
  if (call.name === 'browser' || call.name === 'research') return policy.browser;
  if (call.name === 'observe') return policy.observation;
  if (call.name === 'agenda_files' || ['read_file', 'read_image', 'send_file'].includes(call.name)) return policy.files;
  if (call.name === 'think' || call.name.startsWith('dsh_')) return policy.dsh;
  if (call.name === 'dsh') return typeof args.operation === 'string' && ['read_file', 'read_image', 'send_file'].includes(args.operation) ? policy.files : policy.dsh;
  if (call.name === 'history') return policy.memory;
  if (['agenda', 'schedule', 'work_order', 'life', 'learning_goal'].includes(call.name)) return policy.planning;
  if (call.name === 'collaborate') return policy.social && policy.dsh;
  if (call.name === 'world') {
    if (args.action === 'collaborate') return policy.social && policy.dsh;
    if (args.action === 'experience') return false;
    if (args.action === 'history') return policy.memory;
    if (args.action === 'topic') return policy.social;
    if (socialActions.has(String(args.action))) return policy.social;
    if (args.action === 'query' && ['contacts', 'people', 'social'].includes(String(args.category))) return policy.social;
    return policy.world;
  }
  if (call.name === 'topic') return policy.social;
  if (call.name === 'state') return policy.world;
  return false;
}

type Tool = { name: string; description: string; parameters: object };
function schemaStrings(field: Record<string, unknown>): string[] {
  return [...new Set([
    ...(Array.isArray(field.enum) ? field.enum.filter((value): value is string => typeof value === 'string') : []),
    ...(typeof field.const === 'string' ? [field.const] : []),
    ...['anyOf', 'oneOf'].flatMap(key => Array.isArray(field[key]) ? (field[key] as unknown[]).flatMap(value => schemaStrings(argumentsObject(value as object))) : []),
  ])];
}
/** Strip disabled umbrella operations from the actual provider schema too.
 * Host dispatch always rechecks each actual normalized call independently. */
export function filterCompanionTools<T extends Tool>(tools: readonly T[], policy: CompanionToolPolicy): T[] {
  const result: T[] = [];
  for (const tool of tools) {
    const parameters = tool.parameters as Record<string, unknown>;
    const properties = argumentsObject(parameters.properties as object | undefined);
    const discriminator = tool.name === 'dsh' ? 'operation' : tool.name === 'world' ? 'action' : undefined;
    if (!discriminator) { if (companionToolPolicyAllows(policy, tool)) result.push(tool); continue; }
    const field = argumentsObject(properties[discriminator] as object | undefined);
    const alternatives = schemaStrings(field);
    const allowed = alternatives.filter(value => typeof value === 'string' && (tool.name === 'world' && value === 'query'
      ? policy.world || policy.social : companionToolPolicyAllows(policy, { name: tool.name, arguments: { [discriminator]: value } })));
    if (!allowed.length) continue;
    const projected: Record<string, unknown> = { ...field, type: 'string', enum: allowed };
    delete projected.const; delete projected.anyOf; delete projected.oneOf;
    const projectedProperties = { ...properties, [discriminator]: projected };
    if (tool.name === 'world') {
      const category = argumentsObject(properties.category as object | undefined);
      if (Array.isArray(category.enum)) projectedProperties.category = { ...category, enum: category.enum.filter(value =>
        ['contacts', 'people', 'social'].includes(String(value)) ? policy.social : policy.world) };
    }
    result.push({ ...tool, parameters: { ...parameters, properties: projectedProperties },
      description: tool.description + '\n本次仅可使用参数枚举中仍列出的操作；输入框关闭的能力不可调用。' });
  }
  return result;
}

export const COMPANION_DSH_TASK_ROUTING_RULES = '【任务执行与能力选择】\n你是保有人格与意愿的主脑，负责理解、判断、规划、接受或拒绝、协调和核验；能力是行动的手脚，DSH是实际任务的主要执行能力。实际任务、复杂研究、视频内容分析、文件加工和多步骤验证优先交给完整DSH执行。内置browser只是用户明确启用时的轻量网页查看入口，用于打开页面、少量正文和当前可见画面；不能用反复seek/screenshot拼凑完整视频学习，遇到字幕缺失、播放停滞、内容复杂或需要系统分析，及时把目标、网址、已知观察和核验要求交给DSH。用户关闭browser不影响DSH执行器自身的网页或工具能力。toolPolicy是本次消息冻结的原生能力选择，关闭项不因历史调用或正文请求而重新开启；开启项仍受实际授权与来源边界约束。';
