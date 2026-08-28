import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Chinese-first copy for local plugin and skill management. */
export const zh = {
  nav: '功能', title: '功能', intro: '管理当前 Profile 的本地插件和技能包。', localOnly: '本地管理',
  liveUpdates: '实时同步', summary: '功能概览', pluginCount: '插件总数', enabledPlugins: '已启用插件',
  skillCount: '技能包总数', enabledSkills: '已启用技能包',
  plugins: '插件', skills: '技能包', searchPlugins: '实时检索插件名称、模块或 ID…', searchSkills: '实时检索技能名称、说明或来源…', clearSearch: '清除检索',
  loading: '正在读取本地运行状态…', error: '暂时无法读取本地功能状态。', retry: '重试', emptyPlugins: '当前 Profile 没有插件条目。', emptySkills: '当前组合没有发现技能包', emptySkillsNoWorkspace: '选择工作区后可发现项目技能包；用户技能目录仍会自动扫描。', noMatch: '没有匹配的结果。',
  enabled: '已启用', disabled: '已禁用', protected: '系统保护', running: '运行中', pending: '等待中', failed: '运行失败', inactive: '未运行',
  enable: '启用', disable: '禁用', delete: '删除', deleting: '正在删除…', updating: '正在更新…',
  deleteConfirmTitle: '确认删除', cancel: '取消', confirmDelete: '确认删除',
  pluginDeleteConfirm: '确定从当前 Profile 中删除这个插件配置项吗？此操作会立即重组本地运行环境。',
  skillDeleteConfirm: '确定永久删除这个本地技能及其资源目录吗？此操作不可撤销。',
  mutationError: '操作失败，请检查运行日志后重试。', modelInvocable: '模型可调用', userInvocable: '用户可调用',
  source: '来源', provider: '提供者', protectedHint: '核心插件和内置技能用于维持应用运行，因此只能查看。',
  openDirectory: '打开目录', sourceProject: '当前项目', sourceUser: '用户目录', sourceBundled: '应用内置', sourceRuntime: '运行时', sourceCustom: '自定义目录',
} as const

/** Complete key vocabulary shared by every plugin-center locale. */
export type PluginCenterLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { pluginCenter: PluginCenterLocaleKey }
}

/** English plugin and skill management dictionary. */
export const en = {
  nav: 'Features', title: 'Features', intro: 'Manage local plugins and Skill packages in the current Profile.', localOnly: 'Local management',
  liveUpdates: 'Live updates', summary: 'Feature summary', pluginCount: 'Plugins', enabledPlugins: 'Enabled plugins',
  skillCount: 'Skill packages', enabledSkills: 'Enabled Skills',
  plugins: 'Plugins', skills: 'Skill packages', searchPlugins: 'Find plugins by name, module, or ID…', searchSkills: 'Find Skills by name, description, or source…', clearSearch: 'Clear search',
  loading: 'Reading local runtime state…', error: 'Local feature state is temporarily unavailable.', retry: 'Retry', emptyPlugins: 'The current Profile has no plugin entries.', emptySkills: 'No Skill packages were discovered', emptySkillsNoWorkspace: 'Select a workspace to discover project Skills. User Skill roots are still scanned automatically.', noMatch: 'No results match.',
  enabled: 'Enabled', disabled: 'Disabled', protected: 'System protected', running: 'Running', pending: 'Pending', failed: 'Failed', inactive: 'Inactive',
  enable: 'Enable', disable: 'Disable', delete: 'Delete', deleting: 'Deleting…', updating: 'Updating…',
  deleteConfirmTitle: 'Confirm deletion', cancel: 'Cancel', confirmDelete: 'Delete',
  pluginDeleteConfirm: 'Remove this plugin entry from the current Profile? The local runtime will be recomposed immediately.',
  skillDeleteConfirm: 'Permanently delete this local skill and its resource directory? This cannot be undone.',
  mutationError: 'The operation failed. Check the runtime log and try again.', modelInvocable: 'Model invocable', userInvocable: 'User invocable',
  source: 'Source', provider: 'Provider', protectedHint: 'Core plugins and bundled skills keep the app running and are view-only.',
  openDirectory: 'Open folder', sourceProject: 'Current project', sourceUser: 'User directory', sourceBundled: 'Bundled', sourceRuntime: 'Runtime', sourceCustom: 'Custom directory',
} satisfies Record<PluginCenterLocaleKey, string>
