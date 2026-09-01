import type { ProjectTemplate } from '@deepseek-ai/dsh-worldline-standard/types'

const LABELS: Readonly<Record<string, string>> = {
  active: '已启用',
  approved: '已批准',
  autonomous: '自主行动',
  blank: '空白世界',
  blocked: '存在阻断',
  buildable: '可构建',
  cancelled: '已取消',
  character: '角色推理',
  charter: '世界宪章',
  'character-story': '角色故事',
  civilization: '文明',
  'civilization-sandbox': '文明沙盘',
  compiler: '世界编译',
  completed: '已完成',
  concept: '概念',
  cognition: '角色认知',
  canon: '正典',
  document: '文档',
  facet: '结构属性',
  belief: '认知',
  goal: '目标',
  policy: '行为策略',
  action: '动作',
  actions: '动作',
  lifecycle: '生命周期',
  environment: '环境',
  capability: '能力',
  ontology: '概念体系',
  relationship: '关系',
  provenance: '来源',
  event: '事件',
  scope: '作用范围',
  creative: '创作辅助',
  degraded: '降级运行',
  draft: '创作中',
  entity: '实体',
  failed: '失败',
  fairness: '公平调度',
  'first-person': '第一人称',
  frozen: '已冻结',
  healthy: '运行正常',
  high: '高',
  item: '物品',
  organization: '组织',
  species: '物种',
  relation: '关系',
  fact: '事实',
  timeline: '时间线事件',
  asset: '资源',
  custom: '自定义对象',
  'limited-third-person': '限知第三人称',
  low: '低',
  map: '地图',
  maps: '地图',
  medium: '中',
  narrator: '场景叙事',
  objective: '客观镜头',
  observation: '角色观察',
  open: '待回答',
  pass: '通过',
  paused: '已暂停',
  pending: '待审查',
  place: '地点',
  'playable-scenario': '可游玩剧本',
  player: '玩家接管',
  ready: '可运行',
  rejected: '已拒绝',
  rule: '规则',
  running: '推演中',
  scenario: '剧本',
  systems: '系统',
  invariants: '不变量',
  'social-simulation': '社会推演',
  stopped: '已停止',
  world: '世界',
  plane: '位面',
  region: '区域',
  city: '城市',
  building: '建筑',
  room: '房间',
  slot: '位置槽',
  walk: '步行',
  suggestions: '仅给出建议',
  summary: '记忆摘要',
  telemetry: '运行遥测',
  template: '本地叙事',
  'world-encyclopedia': '世界百科',
  'world-event': '世界事件',
  'decision-trace': '决策依据',
  'ai-intent': 'AI 意图',
  'ai-invocation': 'AI 调用',
  'narrative-beat': '叙事片段',
  'runtime-diagnostic': '运行诊断',
  queued: '等待中',
  closure: '闭包审查',
  purpose: '用途',
  'expectation profile': '预期档案',
  invariant: '不变量',
  space: '空间',
  process: '进程',
  practice: '实践',
  resource: '资源',
  ownership: '所有权',
  state: '状态',
  system: '系统',
  evidence: '证据',
  time: '时间',
  causality: '因果关系',
  safety: '安全性',
  liveness: '活性',
  'event-validity': '事件有效性',
  'behavioral-validity': '行为有效性',
  replay: '确定性回放',
  warning: '需要关注',
  'state delta': '状态变化',
  director: '导演规则',
  control: '控制方式',
  termination: '结束条件',
  projection: '投影',
  'media cue': '媒体提示',
  license: '授权',
  binding: '绑定',
  'epistemic state': '认知状态',
}

const TEMPLATE_DESCRIPTIONS: Readonly<Record<ProjectTemplate, string>> = {
  blank: '从一页空白宪章开始，自由定义世界。',
  'world-encyclopedia': '适合系统整理地点、组织、物种与历史。',
  'character-story': '围绕原创角色、关系与个人故事展开。',
  'social-simulation': '关注人群、制度、经济与社会互动。',
  'civilization-sandbox': '用于文明尺度的长期演化与推演。',
  'playable-scenario': '从设定到演算和文字游玩的完整起点。',
}

/** Perform worldline label through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
export function worldlineLabel(value: string): string {
  return LABELS[value.toLowerCase()] ?? value
}

/** Perform template label through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
export function templateLabel(value: ProjectTemplate): string {
  return worldlineLabel(value)
}

/** Perform template description through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
export function templateDescription(value: ProjectTemplate): string {
  return TEMPLATE_DESCRIPTIONS[value]
}

/** Perform chinese date through the package's public contract.
 * @param value - The value supplied by the caller.
 * @returns The result produced by the operation.
 */
export function chineseDate(value: string | number | Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value))
}
