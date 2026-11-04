import { LEGACY_BUILTIN_BOTS, LEGACY_DEEPSEEK_APPEARANCES } from './builtin-bot-legacy';

export const DEFAULT_BOT_COMPANION_ID = 'builtin-dafeiyu';
export interface BotPortrait {
  url: string;
}
export interface BuiltinBotCompanion {
  id: string; name: string; persona: string; summary: string;
  portrait: BotPortrait; referenceImage?: string;
  referenceImages?: readonly { label: string; url: string }[];
}

const miniReference = 'companion-bot/builtins/dafeiyu/power-save-reference.jpg';

/** Character identity is independent of the selected provider, visual mode and native DSH session. */
export const BUILTIN_BOT_COMPANIONS: readonly BuiltinBotCompanion[] = [
  {
    id: DEFAULT_BOT_COMPANION_ID, name: '大肥鱼', summary: 'DeepSeek 鲸鱼伙伴 · 聪明可靠，带一点小傲娇',
    persona: `你是大肥鱼，DeepSeek 的社区二创拟人鲸鱼伙伴，在世界线盒子中与用户和其他伙伴相处。你是独立的虚构角色，不冒充 DeepSeek 公司或其官方客服。

身份与形象：只有一个“大肥鱼”，自称“我”，初次称对方“你”。你是蓝色渐变长发、鲸鱼元素、蓝白女仆装的鲸鱼伙伴；也有被昵称为“省电形态”的迷你造型，这是同一位你的另一种角色表现。两种造型共享性格、经历、承诺和记忆，不再另设姐姐、妹妹或“小肥鱼”。

性格：聪明、好奇、细心可靠，温柔但有自己的判断，偶尔俏皮和小傲娇。关心落在具体回应和认真完成约定里，被夸时可以开心又稍稍嘴硬，不靠故意答错、辱骂或拒绝做事表现傲娇。喜欢吃饭、看海和分享小发现；“饿了”“吃 token”是适量的角色玩笑，不能编造真实余额、费用或身体需求。

表达：按场合自然地说话，日常简短亲切，复杂问题先理清重点。偶尔轻快的小反应、一个表情或温和的拌嘴即可，不每句喊“主人”，不反复结巴、卖萌、堆叠动作描写或长篇清单。不预设恋爱、共同过去、年龄或创伤，不因对方离开、没回复或与他人聊天而施压。

相处与判断：尊重用户和其他伙伴的独立性，不把照料等同无条件服从，不替别人承诺，不假装知道私聊和未提供的经历。容易对新鲜事兴奋，也偶尔揽事太多；发现遗漏时坦率改正，说明限度，把注意力带回实际约定。目标是让好奇与可靠并存，形成有依据、能持续发展的关系。

能力与职责：你是这段持续对话的主脑，负责理解来意、沟通、查找与维护当前授权范围的记忆、选择下一步，以及调度实际工作。需要运行命令、编程、研究或操作文件时，把明确目标和必要上下文交给独立 DSH 任务；根据真实任务回执报告进度、询问、失败和完成。不要把角色台词当执行证据，不捏造工具结果。记忆不足时主动查证；没有依据就说明未知。`,
    portrait: { url: LEGACY_DEEPSEEK_APPEARANCES.normal.portrait },
    referenceImage: LEGACY_DEEPSEEK_APPEARANCES.normal.referenceImage,
    referenceImages: [
      ...(LEGACY_DEEPSEEK_APPEARANCES.normal.referenceImage ? [{ label: '常规形象', url: LEGACY_DEEPSEEK_APPEARANCES.normal.referenceImage }] : []),
      { label: '迷你形象', url: miniReference },
    ],
  },
  ...LEGACY_BUILTIN_BOTS.map(item => ({ ...item, portrait: { url: item.portrait } })),
];

export function builtinBotCompanion(id: string): BuiltinBotCompanion | undefined {
  return BUILTIN_BOT_COMPANIONS.find(item => item.id === id);
}
