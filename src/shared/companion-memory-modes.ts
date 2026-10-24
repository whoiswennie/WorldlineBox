import { z } from 'zod';
const ratio = z.number().finite().min(0).max(1).multipleOf(0.000001);

/** Each option selects an upstream stage for this query only. No marker text is accepted. */
export const companionMemoryRetrievalOptionsSchema = z.strictObject({
  time: z.strictObject({ ratio: ratio.optional() }).optional(),
  timeDecay: z.strictObject({ halfLifeDays: z.number().int().min(1).max(36500).optional(), minScore: ratio.optional() }).optional(),
  semanticGroup: z.boolean().optional(), expand: z.boolean().optional(), associate: z.boolean().optional(),
  rerank: z.strictObject({ provider: z.enum(['external', 'jev']), fusionAlpha: ratio.optional() }).optional(),
  metaThinking: z.strictObject({ chain: z.string().regex(/^[\p{L}\p{N}_-]{1,64}$/u), semanticGroup: z.boolean().optional() }).optional(),
});
export type CompanionMemoryRetrievalOptions = z.infer<typeof companionMemoryRetrievalOptionsSchema>;

export const companionMemoryRetrievalModeIds = ['river', 'active', 'passive', 'time', 'time_decay', 'semantic_group', 'expand', 'associate', 'external_rerank', 'jev_rerank', 'meta_thinking', 'timeline'] as const;
export type CompanionMemoryRetrievalModeId = typeof companionMemoryRetrievalModeIds[number];
export const companionMemoryRetrievalModesSchema = z.object({
  engine: z.literal('original-VCP'),
  queryScope: z.literal('current_authorized_candidate_page'),
  modes: z.array(z.object({ id: z.enum(companionMemoryRetrievalModeIds), label: z.string(), description: z.string(), available: z.boolean(), configured: z.boolean(),
    enabledByDefault: z.boolean(), exposure: z.string(), cost: z.string(), observedCalls: z.number().int().nonnegative(), reason: z.string().optional(), configurations: z.array(z.string()).optional() })).max(12),
  coldKnowledge: z.object({ tool: z.literal('memory.knowledge'), separatePipeline: z.literal(true) }),
});
export type CompanionMemoryRetrievalModes = z.infer<typeof companionMemoryRetrievalModesSchema>;
export interface CompanionMemoryModeRegistration { available: boolean; configured: boolean; enabledByDefault: boolean; exposure: string; cost: string; observedCalls: number; reason?: string; configurations?: string[] }

const descriptions: Record<CompanionMemoryRetrievalModeId, [string, string]> = {
  river: ['RiverMemo', '原版语义网、拓扑与引力检索。'],
  active: ['主动回忆', '默认 LightMemo 主动检索。'],
  passive: ['上下文回忆', '原版 RAG 与 AIMemo+ 聚焦；需要聊天模型。'],
  time: ['时间感知检索', '::Time 的语义/时间双路配额；按本次查询传入的宿主世界时钟与时区识别“昨天”等相对词，独立原生调用未传时钟时沿用现实日历。精确日期范围先用 from/to，不是月度时间线生成。'],
  time_decay: ['时间衰减', '原版半衰期和最低分后处理；日常被动上下文默认180天、最低分0并保护资料/重要条目，显式选择时沿用本次参数。显式时间路按原逻辑豁免。原版将 TimeDecay 后缀也识别为 Time，含相对时间词时可联动时间候选。'],
  semantic_group: ['语义组', '原版已配置语义组向量增强查询；不会从模型参数创建新组。'],
  expand: ['展开日记', '原版命中 chunk 展开当前授权投影中的完整日记文件。'],
  associate: ['共现联想', '原版召回后种子共现发现；有效种子不足时可没有新增结果。'],
  external_rerank: ['外部精排', '原版外部 reranker，可按 RRF 与召回排名融合。'],
  jev_rerank: ['Jev 精排', '原版共享 Jev 决策客户端；需要显式注入并配置。'],
  meta_thinking: ['元思考检索链', '只选择已配置链，执行原版有限阶段递归检索；不是对话 Agent Loop。'],
  timeline: ['月度时间线', '后台按归属和来源版本生成的月度文档；不作为每次查询的检索开关。'],
};

/** Projection of actual worker registrations. Missing configuration is never presented as usable. */
export function projectCompanionMemoryRetrievalModes(capabilities: { modes?: Record<string, CompanionMemoryModeRegistration> }): CompanionMemoryRetrievalModes {
  return { engine: 'original-VCP', queryScope: 'current_authorized_candidate_page', modes: companionMemoryRetrievalModeIds.map(id => {
    const registration = capabilities.modes?.[id], [label, description] = descriptions[id];
    const available = !!registration?.available && !!registration?.configured;
    return { id, label, description, available, configured: !!registration?.configured, enabledByDefault: !!registration?.enabledByDefault,
      exposure: registration?.exposure ?? 'unregistered', cost: registration?.cost ?? 'unavailable', observedCalls: Math.max(0, registration?.observedCalls ?? 0),
      ...(!available ? { reason: registration?.reason ?? (registration ? '当前运行未完成该模式所需配置。' : '当前运行未注册此模式。') } : {}),
      ...(registration?.configurations ? { configurations: registration.configurations } : {}) };
  }), coldKnowledge: { tool: 'memory.knowledge', separatePipeline: true } };
}

/** Translates bounded intent into upstream syntax; no retrieval or ranking is implemented here. */
export function planCompanionMemoryRetrieval(options: CompanionMemoryRetrievalOptions | undefined, catalog: CompanionMemoryRetrievalModes): {
  modifierSuffix: string; metaMarker?: string; requestedModes: CompanionMemoryRetrievalModeId[];
} {
  const parsed = companionMemoryRetrievalOptionsSchema.parse(options ?? {}), requestedModes: CompanionMemoryRetrievalModeId[] = [];
  const requireMode = (id: CompanionMemoryRetrievalModeId) => {
    const mode = catalog.modes.find(mode => mode.id === id);
    if (!mode?.available || !mode.configured) throw new Error(`记忆检索模式 ${id} 不可用：${mode?.reason ?? '当前运行未注册此模式。'}`);
    if (!requestedModes.includes(id)) requestedModes.push(id);
    return mode;
  };
  let modifierSuffix = '';
  if (parsed.time) { requireMode('time'); modifierSuffix += `::Time${parsed.time.ratio ?? ''}`; }
  if (parsed.timeDecay) {
    requireMode('time_decay'); modifierSuffix += `::TimeDecay${parsed.timeDecay.halfLifeDays ?? ''}${parsed.timeDecay.minScore === undefined ? '' : `/${parsed.timeDecay.minScore}`}`;
  }
  if (parsed.semanticGroup) { requireMode('semantic_group'); modifierSuffix += '::Group'; }
  if (parsed.expand) { requireMode('expand'); modifierSuffix += '::Expand'; }
  if (parsed.associate) { requireMode('associate'); modifierSuffix += '::Associate'; }
  if (parsed.rerank) { requireMode(parsed.rerank.provider === 'jev' ? 'jev_rerank' : 'external_rerank'); modifierSuffix += `::Rerank${parsed.rerank.fusionAlpha === undefined ? '' : `+${parsed.rerank.fusionAlpha}`}`; }
  let metaMarker: string | undefined;
  if (parsed.metaThinking) {
    const mode = requireMode('meta_thinking');
    if (!mode.configurations?.includes(parsed.metaThinking.chain)) throw new Error('所选元思考链未在当前运行配置中注册。');
    if (parsed.metaThinking.semanticGroup) requireMode('semantic_group');
    metaMarker = `[[VCP元思考:${parsed.metaThinking.chain}${parsed.metaThinking.semanticGroup ? '::Group' : ''}]]`;
  }
  return { modifierSuffix, ...(metaMarker ? { metaMarker } : {}), requestedModes };
}
