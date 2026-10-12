/** Native / overlay save-menu copy for connection state. */

export function saveMenuTitle(connected: boolean): string {
  return connected ? '保存到 WorldlineBox' : '保存到 WorldlineBox（未连接）';
}

export function disconnectedMenuHint(): string {
  return '请先启动 WorldlineBox 并打开资源库';
}
