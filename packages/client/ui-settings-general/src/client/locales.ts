/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '系统设置',
  'subtitle': '配置模型、Agent、插件与交互方式',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'general.description': '界面外观与基础交互',
  'models.description': 'API 与模型设置',
  'agent-presets.description': 'Agent 运行策略',
  'plugins.description': '插件与扩展管理',
  'section.description': '功能配置与管理',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'System settings',
  'subtitle': 'Configure models, agents, plugins, and interactions',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'general.description': 'Appearance and basic interactions',
  'models.description': 'API and model settings',
  'agent-presets.description': 'Agent runtime strategies',
  'plugins.description': 'Plugins and extensions',
  'section.description': 'Feature configuration',
} satisfies Record<SettingsKey, string>
