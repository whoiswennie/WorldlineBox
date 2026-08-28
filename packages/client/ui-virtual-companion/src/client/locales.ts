import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Simplified Chinese strings for the virtual companion surface. */
export const zh = {
  nav: '虚拟伙伴', title: '虚拟伙伴', intro: '像好友一样认识、选择并启动你的 AI 伙伴。',
  search: '搜索伙伴', friendGroup: '内置伙伴', online: '可联系', builtIn: '内置',
  yachiyoName: '月见八千代', yachiyoHandle: 'YACHIYO RUNAMI · 月读管理者',
  yachiyoStatus: '今天也在守望每个人自由创作的空间。',
  yachiyoAbout: '虚拟空间“月读”的管理者兼顶级主播。能歌善舞、能够分身，是一位年龄为 8000 岁（设定）的神秘 AI。元气而温柔，喜欢陪伴并守望创作者。',
  companionProfile: '伙伴资料', traits: '相处风格',
  traitWarm: '温柔包容', traitPlayful: '元气自然', traitCreative: '热爱创作', traitMysterious: '神秘 AI',
  launch: '和八千代聊天', launching: '正在建立联系…', noWorkspace: '请先创建一个工作区，再启动伙伴会话。',
  launchError: '暂时无法建立联系',
  profileAware: '启动后会读取当前账户公开的称呼与个人简介，不会读取密码、凭据或头像数据。',
  processLabel: '过程', processShowHint: '显示思考与工具过程', processHideHint: '隐藏思考与工具过程',
  waitingCompanionName: '伙伴', waitingGroupName: '伙伴们',
  waitingRead: '{name}正在读你的消息', waitingThink: '{name}正在想怎么回应你',
  waitingLong: '{name}还在认真想着，没有走开', waitingSpeaking: '{name}正在回应你',
  waitingNarrating: '故事正在这一刻继续',
} as const

/** Locale keys owned by the virtual companion surface. */
export type VirtualCompanionLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { virtualCompanion: VirtualCompanionLocaleKey }
}

/** English strings for the virtual companion surface. */
export const en = {
  nav: 'Companions', title: 'Virtual companions', intro: 'Meet, choose, and start an AI companion like a friend.',
  search: 'Search companions', friendGroup: 'Built-in companions', online: 'Available', builtIn: 'Built in',
  yachiyoName: 'Yachiyo Runami', yachiyoHandle: 'YACHIYO RUNAMI · Tsukuyomi administrator',
  yachiyoStatus: 'Watching over a space where everyone can create freely.',
  yachiyoAbout: 'Administrator and top streamer of the virtual space Tsukuyomi. A mysterious AI who can sing, dance, and duplicate herself, with a stated age of 8,000. Bright, warm, and devoted to creators.',
  companionProfile: 'Companion profile', traits: 'Relationship style',
  traitWarm: 'Warm and accepting', traitPlayful: 'Bright and natural', traitCreative: 'Loves creativity', traitMysterious: 'Mysterious AI',
  launch: 'Chat with Yachiyo', launching: 'Connecting…', noWorkspace: 'Create a workspace before starting a companion session.',
  launchError: 'Could not connect',
  profileAware: 'The session can read your public account name and biography, never your password, credentials, or avatar bytes.',
  processLabel: 'Process', processShowHint: 'Show reasoning and tool activity', processHideHint: 'Hide reasoning and tool activity',
  waitingCompanionName: 'Your companion', waitingGroupName: 'Your companions',
  waitingRead: '{name} is reading your message', waitingThink: '{name} is thinking about how to answer',
  waitingLong: '{name} is still here, giving it some thought', waitingSpeaking: '{name} is replying',
  waitingNarrating: 'The story is moving forward',
} satisfies Record<VirtualCompanionLocaleKey, string>
