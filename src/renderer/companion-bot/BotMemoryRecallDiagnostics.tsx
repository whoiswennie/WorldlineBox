import type { BotMemoryRecallReport } from '../../shared/companion-bot-memory';
import { BotIcon } from './BotIcon';

type Locale = 'zh-CN' | 'en';
type Stage = BotMemoryRecallReport['stages'][number];

// These are presentation labels only. The complete, unmodified records remain
// available below, including nesting, source identifiers, and unknown stages.
const stageNames: Record<string, string> = {
  'host.context.prepare': '上下文准备', 'host.preprocess': '记忆预处理', 'host.start': '运行时就绪检查',
  'host.search': '记忆搜索', 'host.sync': '索引同步', 'host.calltool': '记忆工具调用',
  'host.invoke': '处理召回请求', 'host._expandvariables': '展开记忆占位符',
  'plugin.ragdiaryplugin.processmessages': '日记自动召回', 'plugin.ragdiaryplugin.processtoolcall': '日记查询',
  'plugin.lightmemo.processtoolcall': '主动语义查找', 'plugin.lightmemo.processmessages': '语义记忆处理',
  'chat.deepmemo.processtoolcall': '原话关键词查询', 'plugin.deepmemo.processtoolcall': '原话关键词查询',
  'embedding.query-cache-or-provider': '查询向量准备',
  'knowledge.initialize': '知识索引初始化', 'knowledge.lightmemo': '语义记忆检索',
  'knowledge.river-query': '关联记忆查询', 'knowledge.search': '知识库搜索',
  'knowledge.search-many': '批量知识库搜索', 'knowledge.knn': '近邻向量检索', 'knowledge.knn-many': '批量近邻检索',
  'knowledge.external-rerank': '外部重排', 'knowledge.parallel-rerank': '并行重排',
  'index.load': '日记索引加载', 'retrieval.deduplicate': '召回结果去重',
  'native.memo-observation': '记忆线索分析', 'native.river': '原生关联检索',
  'native.river-hybrid': '原生混合检索', 'native.river-topology': '关联拓扑重排',
  'native.lightmemo': '原生语义检索', 'native.external-rerank': '原生外部重排', 'native.parallel-rerank': '原生并行重排',
  'rag.rerank': '日记结果重排', 'rag.jev': '日记相似度重排', 'rag.bm25-candidates': '关键词候选检索',
  'rag.river-rerank': '日记关联重排', 'rag': '日记召回',
  'lightmemo.rerank': '语义结果重排', 'lightmemo.jev': '语义相似度重排',
  'lightmemo.final-candidates': '语义候选整理', 'lightmemo.pre-aimemo-candidates': '语义候选准备',
  'direct-diary.getbm25diarycandidates': '日记关键词查找', 'direct-diary.processcontent': '日记正文处理',
  'sourcesnapshot.stage': '运行文件准备', 'localembedding.start': '本地向量模型启动',
  'providerrouter.start': '向量服务连接', 'memoryruntime.start': '记忆运行时启动',
};

function stageLabel(name: string, locale: Locale): string {
  if (locale === 'en') return name;
  const key = name.toLowerCase();
  if (stageNames[key]) return stageNames[key];
  if (key.startsWith('cds.') || key.startsWith('chat-host.')) return '聊天记录处理';
  if (key.startsWith('plugin.')) return '记忆插件处理';
  if (key.startsWith('embedding.')) return '向量处理';
  if (key.startsWith('cold.')) return '归档记忆查询';
  return '扩展处理阶段';
}

function stageState(status: string, locale: Locale): { text: string; tone: string } {
  const value = status.toLowerCase();
  const states = [
    { names: ['ok', 'completed', 'complete', 'success', 'succeeded'], zh: '已完成', en: 'Completed', tone: 'complete' },
    { names: ['running', 'started'], zh: '处理中', en: 'Running', tone: 'running' },
    { names: ['failed', 'error'], zh: '未完成', en: 'Failed', tone: 'failed' },
    { names: ['skipped'], zh: '已跳过', en: 'Skipped', tone: 'muted' },
    { names: ['pending', 'queued'], zh: '等待中', en: 'Pending', tone: 'muted' },
    { names: ['not_observed', 'unavailable'], zh: '未观测到', en: 'Not observed', tone: 'muted' },
    { names: ['hook_observed'], zh: '已观测到', en: 'Observed', tone: 'complete' },
  ];
  const found = states.find(item => item.names.includes(value));
  return found ? { text: locale === 'zh-CN' ? found.zh : found.en, tone: found.tone }
    : { text: locale === 'zh-CN' ? status ? '未识别状态' : '未提供' : status || 'Not provided', tone: 'muted' };
}

export function memoryRecallDuration(value: number | undefined, locale: Locale): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return locale === 'zh-CN' ? '未提供' : 'Not provided';
  return `${Math.round(value * 100) / 100} ${locale === 'zh-CN' ? '毫秒' : 'ms'}`;
}

export function BotMemoryRecallDiagnostics({ stages, locale }: { stages: Stage[]; locale: Locale }) {
  const zh = locale === 'zh-CN', title = zh ? '阶段耗时' : 'Stage durations';
  return <details className="bot-memory-diagnostics">
    <summary><BotIcon name="clock" /><strong>{title}</strong><span>{zh ? `${stages.length} 个阶段` : `${stages.length} stages`}</span><svg className="bot-memory-diagnostics-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></summary>
    <div className="bot-memory-diagnostics-body">
      <p className="bot-memory-span-hint">{zh ? '阶段可能嵌套，不能相加为总耗时。下方保持原始执行顺序。' : 'Stages may overlap or nest; their durations must not be added. Original execution order is preserved below.'}</p>
      <div className="bot-memory-stages" aria-label={title}>
        {stages.length ? stages.map((stage, index) => {
          const state = stageState(stage.status || '', locale);
          return <div className="bot-memory-stage" key={`${stage.name}-${index}`}>
            <span className="bot-memory-stage-order" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <div><span className="bot-memory-stage-name">{stageLabel(stage.name, locale)}</span><span className="bot-memory-stage-status" data-tone={state.tone}>{state.text}</span></div>
            <strong>{memoryRecallDuration(stage.durationMs, locale)}</strong>
          </div>;
        }) : <p className="bot-memory-stage-empty">{zh ? '未提供阶段测量记录' : 'No stage measurements provided'}</p>}
      </div>
      <details className="bot-memory-stage-raw"><summary>{zh ? '原始阶段诊断' : 'Original stage diagnostics'}</summary><pre>{JSON.stringify(stages, null, 2)}</pre></details>
    </div>
  </details>;
}
