/**
 *  Technical presentation facts are ordinary open tags, not a user-facing closed kind system.
 * @param mimeType - mime type value.
 * @returns The resulting value.
 */
export function inferReferenceMediaTags(mimeType: string): readonly string[] {
  const normalized = mimeType.trim().toLocaleLowerCase('en-US')
  const tags = normalized.startsWith('image/') ? ['图片']
    : normalized.startsWith('audio/') ? ['音频']
      : normalized.startsWith('video/') ? ['视频']
        : normalized.startsWith('text/') ? ['文本']
          : normalized === '' ? ['链接'] : ['文件']
  const subtype = normalized.split('/', 2)[1]?.split(/[;+]/u, 1)[0]
  return [...tags, ...(subtype === undefined || subtype === 'octet-stream' ? [] : [subtype])]
}

/**
 *  Split natural language without imposing a product-owned semantic taxonomy.
 * @param text - text value.
 * @returns The resulting value.
 */
export function expandReferenceQuery(text: string): readonly string[] {
  return text.trim().normalize('NFKC').toLocaleLowerCase('zh-CN')
    .split(/[\s,，。！!？?、;；:：]+/u).filter(Boolean).slice(0, 32)
}
