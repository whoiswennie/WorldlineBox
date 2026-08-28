/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'dialog.preparingTitle': '正在导出会话',
  'dialog.preparingDescription': '正在准备包含当前会话、子会话和附件的 ZIP 文件。',
  'dialog.successTitle': '会话记录已开始下载',
  'dialog.successDescription': '浏览器正在下载会话记录 ZIP 文件。',
  'dialog.errorTitle': '会话记录导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法启动会话记录导出。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'dialog.preparingTitle': 'Exporting Session',
  'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'dialog.successTitle': 'Session download started',
  'dialog.successDescription': 'The browser is downloading the Session ZIP.',
  'dialog.errorTitle': 'Session export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh
