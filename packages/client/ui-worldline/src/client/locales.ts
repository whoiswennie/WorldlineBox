import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const zh = {
  nav: '世界线', title: '世界线工作台', subtitle: '把设定编译成可验证、可回放、可游玩的世界。',
  local: '本地项目', chooseRoot: '选择项目库', chooseRootHint: '世界线项目保存在你选择的本地目录中。文件始终归你所有。',
  chooseDirectory: '选择目录', retry: '重试', loading: '正在读取世界线项目库…', rootError: '无法读取项目库',
  library: '项目库', search: '搜索项目、标签或描述…', newProject: '新建世界', rescan: '重新扫描', rootSettings: '项目库设置',
  noProjects: '还没有世界线项目', noProjectsHint: '从一个结构化模板开始，或导入已有的 .tar.gz 世界包。',
  create: '创建', cancel: '取消', projectName: '项目名称', description: '描述', template: '模板', tags: '标签',
  open: '打开', copy: '创建副本', trash: '移到回收站', restore: '恢复', trashBin: '回收站',
  importProject: '导入', exportProject: '导出', sourcePath: '归档路径', destinationPath: '导出路径', includeRuns: '包含运行记录',
  overview: '总览', canon: '设定', map: '地图', build: '构建', simulation: '模拟', textPlay: '文本游玩', back: '返回项目库',
  status: '状态', documents: '文档', size: '大小', updated: '更新于', health: '健康度', projectPath: '项目路径', openFolder: '打开目录', chatWithAuthor: '与世界线助手对话',
  files: '文件', createFile: '新建文档', createFolder: '新建文件夹', path: '路径', save: '保存', saved: '已保存', saving: '保存中', dirty: '未保存', conflict: '版本冲突',
  edit: '编辑', preview: '预览', split: '分栏', history: '历史', backlinks: '反向链接', deleteEntry: '删除条目', renameMove: '移动/重命名', duplicateEntry: '复制条目',
  searchInProject: '搜索设定内容…', restoreServer: '载入磁盘版本', overwrite: '以当前内容重试', autosave: '自动保存已启用', externalChange: '检测到磁盘上的外部修改', openDocuments: '已打开文档',
  cut: '剪切', paste: '粘贴', pasteSamePath: '不能粘贴到原路径，请先选择目标文件夹。', trashConfirm: '该条目将移入可恢复的回收站。', importFiles: '导入文件', importingFiles: '正在流式导入',
  mapEmpty: '当前文档没有可解析的 worldline-map JSON 代码块。', mapHint: '地图编辑器只修改当前文档中的结构化地图块。', autoLayout: '自动布局', undo: '撤销', redo: '重做', validate: '验证', addNode: '添加节点', addEdge: '添加边', layers: '图层', visibility: '可见性', lock: '锁定', layerLocked: '该图层已锁定，节点不可编辑。', background: '底图资源', zoom: '缩放', visibleNodes: '视口节点', clusteredNodes: '个聚合节点',
  compile: '编译预览', freeze: '冻结并激活', sourceCoverage: '来源覆盖率', diagnostics: '诊断', questions: '创作问题', proposals: '提案审查', certificate: '闭包证书', answer: '回答', approve: '批准', reject: '拒绝', explain: '解释来源',
  noBuild: '尚未编译。编译会从当前稳定快照生成可审查的 Blueprint。', freezeReady: '所有闭包门禁已通过，可以冻结。', freezeBlocked: '仍有阻断项，不能冻结。',
  runs: '运行', newRun: '新建运行', seed: '随机种子', startPaused: '以暂停状态启动', pause: '暂停', resume: '继续', advance: '推进', stop: '停止', checkpoint: '检查点', checkpoints: '检查点与回放', branch: '创建分支', replayBranch: '回放为新分支', causalExplanation: '因果解释',
  logicalTime: '逻辑时间', sequence: '序列', queue: '未来队列', processes: '进程', reservations: '预留', fairness: '公平干预', deadlocks: '死锁恢复', livelocks: '活锁恢复', events: '事件流', entities: '实体', controls: '控制模式',
  runtimeMap: '运行地图', remaining: '剩余时间', mapProjectionClipped: '当前投影已按节点上限裁剪；缩小视口可查看更精确的区域。',
  ai: 'AI', aiEnabled: 'AI 已启用', aiDisabled: '仅确定性运行', modelCatalog: '模型目录', modelRoute: '模型路由', defaultReasoning: '默认推理强度', budget: '预算', budgetAvailable: '预算可用', budgetBlocked: '预算已阻断 AI', context: '上下文包', decide: '让角色决策',
  actor: '角色', narrator: '叙事者', narrate: '叙述当前场景', choices: '合法选择', freeInput: '用自然语言描述意图…', submit: '提交', savePoint: '保存点', rephrase: '重新表述', retryChoice: '从保存点重试',
  storyStage: 'StoryStage', unavailable: '不可用', templateNarration: '模板叙事', error: '操作失败', close: '关闭', confirm: '确认',
  relocate: '迁移项目库', dryRun: '先检查', applyRelocation: '执行迁移', conflicts: '冲突', requiredSpace: '所需空间',
} as const

export type WorldlineLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { worldlineStudio: WorldlineLocaleKey }
}

export const en = {
  nav: 'Worldline', title: 'Worldline Studio', subtitle: 'Compile lore into a verifiable, replayable, playable world.',
  local: 'Local projects', chooseRoot: 'Choose project library', chooseRootHint: 'Worldline projects stay in the local directory you choose. Your files remain yours.',
  chooseDirectory: 'Choose directory', retry: 'Retry', loading: 'Reading the Worldline project library…', rootError: 'Could not read the project library',
  library: 'Library', search: 'Search projects, tags, or descriptions…', newProject: 'New world', rescan: 'Rescan', rootSettings: 'Library settings',
  noProjects: 'No Worldline projects yet', noProjectsHint: 'Start from a structured template, or import an existing .tar.gz world package.',
  create: 'Create', cancel: 'Cancel', projectName: 'Project name', description: 'Description', template: 'Template', tags: 'Tags',
  open: 'Open', copy: 'Create copy', trash: 'Move to trash', restore: 'Restore', trashBin: 'Trash',
  importProject: 'Import', exportProject: 'Export', sourcePath: 'Archive path', destinationPath: 'Export path', includeRuns: 'Include runs',
  overview: 'Overview', canon: 'Canon', map: 'Map', build: 'Build', simulation: 'Simulation', textPlay: 'Text play', back: 'Back to library',
  status: 'Status', documents: 'Documents', size: 'Size', updated: 'Updated', health: 'Health', projectPath: 'Project path', openFolder: 'Open folder', chatWithAuthor: 'Chat with Worldline Author',
  files: 'Files', createFile: 'New document', createFolder: 'New folder', path: 'Path', save: 'Save', saved: 'Saved', saving: 'Saving', dirty: 'Unsaved', conflict: 'Revision conflict',
  edit: 'Edit', preview: 'Preview', split: 'Split', history: 'History', backlinks: 'Backlinks', deleteEntry: 'Delete entry', renameMove: 'Move / rename', duplicateEntry: 'Duplicate entry',
  searchInProject: 'Search canon…', restoreServer: 'Load disk version', overwrite: 'Retry with current content', autosave: 'Autosave enabled', externalChange: 'An external disk change was detected', openDocuments: 'Open documents',
  cut: 'Cut', paste: 'Paste', pasteSamePath: 'Choose a destination folder before pasting into the same path.', trashConfirm: 'This entry will move to the recoverable trash.', importFiles: 'Import files', importingFiles: 'Streaming import',
  mapEmpty: 'The current document has no parseable worldline-map JSON fence.', mapHint: 'The map editor changes only the structured map block in the current document.', autoLayout: 'Auto layout', undo: 'Undo', redo: 'Redo', validate: 'Validate', addNode: 'Add node', addEdge: 'Add edge', layers: 'Layers', visibility: 'Visibility', lock: 'Lock', layerLocked: 'This layer is locked; its nodes cannot be edited.', background: 'Background asset', zoom: 'Zoom', visibleNodes: 'viewport nodes', clusteredNodes: 'clustered nodes',
  compile: 'Compile preview', freeze: 'Freeze and activate', sourceCoverage: 'Source coverage', diagnostics: 'Diagnostics', questions: 'Creative questions', proposals: 'Proposal review', certificate: 'Closure certificate', answer: 'Answer', approve: 'Approve', reject: 'Reject', explain: 'Explain source',
  noBuild: 'Not compiled yet. Compile a stable source snapshot into a reviewable Blueprint.', freezeReady: 'All closure gates pass; this build can be frozen.', freezeBlocked: 'Blocking items remain; this build cannot be frozen.',
  runs: 'Runs', newRun: 'New run', seed: 'Random seed', startPaused: 'Start paused', pause: 'Pause', resume: 'Resume', advance: 'Advance', stop: 'Stop', checkpoint: 'Checkpoint', checkpoints: 'Checkpoints and replay', branch: 'Create branch', replayBranch: 'Replay as branch', causalExplanation: 'Causal explanation',
  logicalTime: 'Logical time', sequence: 'Sequence', queue: 'Future queue', processes: 'Processes', reservations: 'Reservations', fairness: 'Fairness interventions', deadlocks: 'Deadlock recovery', livelocks: 'Livelock recovery', events: 'Event stream', entities: 'Entities', controls: 'Control mode',
  runtimeMap: 'Runtime map', remaining: 'remaining', mapProjectionClipped: 'This projection reached its node limit; narrow the viewport for a more precise area.',
  ai: 'AI', aiEnabled: 'AI enabled', aiDisabled: 'Deterministic only', modelCatalog: 'Model catalog', modelRoute: 'Model route', defaultReasoning: 'Default reasoning', budget: 'Budget', budgetAvailable: 'Budget available', budgetBlocked: 'Budget blocks AI', context: 'Context pack', decide: 'Let actor decide',
  actor: 'Actor', narrator: 'Narrator', narrate: 'Narrate current scene', choices: 'Legal choices', freeInput: 'Describe an intent in natural language…', submit: 'Submit', savePoint: 'Save point', rephrase: 'Rephrase', retryChoice: 'Retry from save',
  storyStage: 'StoryStage', unavailable: 'Unavailable', templateNarration: 'Template narration', error: 'Operation failed', close: 'Close', confirm: 'Confirm',
  relocate: 'Relocate library', dryRun: 'Check first', applyRelocation: 'Relocate', conflicts: 'Conflicts', requiredSpace: 'Required space',
} satisfies Record<WorldlineLocaleKey, string>
