export function companionGroupTitle(names: readonly string[]): string {
  const members = ['我', ...names];
  return (members.length === 1 ? '我的群聊' : members.slice(0, -1).join('、') + '和' + members.at(-1) + '的群聊').slice(0, 100);
}
/** A compact preview, without changing the original stored Markdown. */
export function companionMessagePreview(content: string): string {
  return content.replace(/(?:```|~~~)[\s\S]*?(?:```|~~~)/g, '[代码]').replace(/!\[([^\]]*)\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(^|\n)\s{0,3}#{1,6}\s+/g, ' ').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
}
