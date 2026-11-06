import type { BotDshTool } from './dsh-brain';

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (description: string, maxLength = 16000) => ({ type: 'string', description, minLength: 1, maxLength });
const memoryConversation = { type: 'string', maxLength: 160, description: '可省略，默认当前域。仅用户私聊中可选agent_memory_scopes列出的本人用户参与会话；不能传路径或其他伙伴。' };
/** The router has no raw shell/filesystem tool; work is delegated to a scoped DSH session. */
export const BOT_TOOLS: BotDshTool[] = [
  { name: 'agent_state', description: '读取自己持续主脑的统一事件序列和当前受众获准的任务协调视图。用户私聊可查看自己在用户参与会话中的任务元数据；群、伙伴私聊和世界仅本会话。不会读取其他受众的聊天或记忆，也不授予新工作权限。', parameters: object({}, []) },
  { name: 'dsh_task_result_read', description: '分页读取当前伙伴自己的任务执行结果原文。task_done或任务摘要明确为摘录时，通过offset/nextOffset读剩余部分，不把短摘录当成完整结果。只读，不会再次执行任务。', parameters: object({ taskId: string('任务编号', 160), offset: { type: 'integer', minimum: 0, maximum: 10000000 }, limit: { type: 'integer', minimum: 1, maximum: 12000 } }, ['taskId']) },
  { name: 'context_handoff_read', description: '分页读取当前主脑代际的完整交接摘要或尾部原件。交接预览不包含全部旧事实，需要细节时按nextOffset继续，不能访问其他伙伴/受众。', parameters: object({ section: { type: 'string', enum: ['summary', 'tail'] }, offset: { type: 'integer', minimum: 0 } }, []) },
  { name: 'chat_read_message', description: '按本轮sourceMessageId或同会话已有消息ID分页读取原文。长消息预览不包含全部需求，读取时沿nextOffset继续；不能访问其他会话或未来消息。', parameters: object({ messageId: string('当前会话原消息ID', 160), offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1200 } }, ['messageId']) },
  { name: 'chat_list_stickers', description: '列出当前聊天可用的真实表情包和表情ID，可按名称查找；不要编造图片或表情ID。', parameters: object({ query: { type: 'string', maxLength: 200 }, packId: { type: 'string', maxLength: 160 } }, []) },
  { name: 'chat_send_sticker', description: '按已列出的表情ID向当前聊天发送一张真实图片或动图。可以只发表情，也可以附自然短句；成功回执即已发送，不必另造填充正文。', parameters: object({ stickerId: string('真实表情ID', 160), caption: { type: 'string', maxLength: 24000 } }, ['stickerId']) },
  { name: 'chat_list_files', description: '分页查询本聊天已分享图片、音频、视频及文件，返回核验后的绝对路径、哈希和稳定ID；沿nextOffset读取完整清单，不访问其他聊天或未发送草稿。', parameters: object({ query: { type: 'string', maxLength: 200 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 80 } }, []) },
  { name: 'chat_send_file', description: '向当前聊天发送实际附件。可用已分享attachmentId；或自身taskId和工作区真实相对path。同任务同路径且当前文件ID/hash一致时默认只返回已发送回执，不重复发；用户明确要求再发才设resend:true。文件内容已更新则发新版本。不能用其他聊天路径、任意URL或假产物。', parameters: object({ attachmentId: { type: 'string', maxLength: 160 }, taskId: { type: 'string', maxLength: 160 }, path: { type: 'string', maxLength: 32768 }, caption: { type: 'string', maxLength: 24000 }, resend: { type: 'boolean' } }, []) },
  { name: 'agent_memory_scopes', description: '分页列出本伙伴可主动查询的记忆会话，不启动VCP。用户私聊可列用户与本人仍参与的direct/group；群、伙伴私聊及世界仅当前域。按nextCursor继续。', parameters: object({ cursor: { type: 'string', maxLength: 160 }, limit: { type: 'integer', minimum: 1, maximum: 30 } }, []) },
  { name: 'memory_search', description: '语义补查获准长期记忆。默认本域；用户私聊可用conversationId查询scope目录中的本人其他用户会话，返回来源。缺可核实来源时unavailable，不能凭空作答。', parameters: object({ query: string('具体查询问题', 4000), conversationId: memoryConversation }, ['query']) },
  { name: 'memory_recall_details', description: '读取本轮被动召回的完整证据。省略citationId列引用；按短证据卡的host-memory引用和nextOffset分页回查原文/来源，不重新做一次语义召回，不访问其他受众。', parameters: object({ citationId: { type: 'string', maxLength: 160 }, offset: { type: 'integer', minimum: 0 } }, []) },
  { name: 'memory_history', description: '按具体关键词回查原始聊天，默认本域。用户私聊可指定获准conversationId；跨域结果须来源可核实，不可用时到原会话查询。', parameters: object({ keyword: string('关键词或原检索DSL', 4000), conversationId: memoryConversation }, ['keyword']) },
  { name: 'memory_read', description: '列出或读取历史片段，默认本域；用户私聊可指定获准conversationId。跨域结果须来源可核实，返回unavailable不能当作没有历史。', parameters: object({ topicId: { type: 'string', description: '省略时列出可读历史片段', maxLength: 200 }, conversationId: memoryConversation }, []) },
  { name: 'memory_write', description: '保存明确的事实、偏好、承诺或更正，保留时间、适用范围和不确定性。不要把猜测写成用户事实。', parameters: object({ content: string('要记录的记忆', 24000) }, ['content']) },
  { name: 'memory_list', description: '分页查受管日记的稳定ID、预览与checksum。默认本域；用户私聊可选获准conversationId，按nextCursor继续，再memory_note读取；跨域仅只读，修改/整理/忘记仍在原域。', parameters: object({ query: { type: 'string', maxLength: 4000 }, tag: { type: 'string', maxLength: 64 }, cursor: { type: 'string', maxLength: 1000 }, limit: { type: 'integer', minimum: 1, maximum: 60 }, conversationId: memoryConversation }, []) },
  { name: 'memory_note', description: '按稳定ID读完整日记和checksum，默认本域；用户私聊可指定获准conversationId。跨域只读，不授权写入或整理；不能传路径选择其他伙伴。', parameters: object({ id: string('所选域的日记ID', 200), conversationId: memoryConversation }, ['id']) },
  { name: 'memory_update', description: '依据明确的新事实或更正更新一篇已读日记，保留作者、适用时间、来源与必要历史变化。必须提供刚读取的checksum；conflict时重新读取。pending表示文件已写但索引待完成，不要宣称已可召回。', parameters: object({ id: string('日记ID', 200), expectedChecksum: string('memory_note返回的checksum', 32), content: string('更新后的完整日记', 24000), tags: { type: 'array', maxItems: 12, items: string('标签', 64) } }, ['id', 'expectedChecksum', 'content']) },
  { name: 'memory_organize', description: '将2至16篇已完整读取的相关日记整理为一篇，保留事实差异、更正时间和不确定性，不丢掉不同作者或未决事项。每源须当前checksum；仅本域。新日记可召回后归档旧篇，partial/pending须如实说明，不重复新建同目标整理。', parameters: object({ sources: { type: 'array', minItems: 2, maxItems: 16, items: object({ id: string('本域日记ID', 200), expectedChecksum: string('读取时checksum', 32) }, ['id', 'expectedChecksum']) }, content: string('完整整理结果', 24000), tags: { type: 'array', maxItems: 12, items: string('标签', 64) } }, ['sources', 'content']) },
  { name: 'memory_forget', description: '按列出的稳定ID撤回这条记忆及其来源衍生内容的使用，阻止重新捕获。不会物理擦除旧原始聊天日志。仅在用户明确要求忘记时调用。', parameters: object({ id: string('memory_list给出的记忆ID', 200) }, ['id']) },
  { name: 'memory_maintenance', description: '生成待审的整理或梦境候选，或查看当前伙伴和受众的维护进展。用户希望整理/做梦时用plan；日常周期由宿主调度。提交不代表已改写日记，模型不能批准自己的候选。梦境叙事和未批准提案不是用户事实。', parameters: object({ operation: { type: 'string', enum: ['plan', 'status'] }, kind: { type: 'string', enum: ['organize', 'dream'] }, jobId: { type: 'string', maxLength: 160 } }, ['operation']) },
  { name: 'dsh_task', description: '委派真实电脑任务：列桌面/指定目录、查看文件、运行脚本、研究、编码和文件处理均可，不限于复杂多步工作。伙伴任务复用共享DSH实例，使用独立full-access会话和工作目录；完整原生工具能力不是新增授权，必须保留本次原目标及只读、路径、不得删除等用户限制。主脑没有直接read_file也应使用此执行器，不要未调用就声称不能访问电脑。返回任务编号仅表示已提交，完成后宿主回报。附件会复制到任务工作区。', parameters: object({ goal: string('原始目标、授权范围、明确约束和可核验交付要求'), title: string('简短任务名称', 120), attachmentIds: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 160 } } }, ['goal', 'title']) },
  { name: 'dsh_task_control', description: 'Router管理自己的获准任务：list列出；status查看；send追加原目标内指导；answer绑定questionId和原选项回答Worker；cancel立即停止；pause暂停冻结计时；resume_paused恢复原任务。用户暂停须明确继续，已停止不得重启。cancel_queued清排队；cancel_all停止本聊天自己的全部任务；remove/clear_finished移除单项/全部已结束记录，保留文件附件。一次回执即生效，无需反复核实。输出检查点用continue；未知外部效果不可重放。缺用户事实或新授权才询问。', parameters: object({ taskId: string('单任务操作需要任务编号；list与批量操作不传', 200), operation: { type: 'string', enum: ['status', 'send', 'cancel', 'answer', 'continue', 'pause', 'resume_paused', 'remove', 'list', 'cancel_queued', 'cancel_all', 'clear_finished'] },
    page: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 30 }, filter: { type: 'string', enum: ['all', 'active', 'done', 'issues'] }, query: { type: 'string', maxLength: 200 },
    text: string('遵守原目标与用户约束的补充指导或事实；不能替代问题回答'), questionId: string('status返回的原始稳定问题编号；已授权细节可由主脑判断回答，缺少用户偏好或新授权才询问用户', 160), answers: { type: 'array', minItems: 1, items: object({ id: string('问题项编号', 160),
      selected: { type: 'array', items: { type: 'string', maxLength: 300 } }, custom: { type: 'string', maxLength: 12000 } }, ['id', 'selected']) } }, ['operation']) },
  { name: 'world', description: '观察真实世界状态，按可达路径移动、经出入口旅行或与家具交互。动作只控制自己，不能进入其他伙伴私人小屋；移动已接受不表示到达。', parameters: object({ operation: { type: 'string', enum: ['observe', 'move', 'travel', 'interact'] },
    sceneId: { type: 'string' }, x: { type: 'integer', minimum: 0, maximum: 127 }, y: { type: 'integer', minimum: 0, maximum: 127 }, objectId: { type: 'string' },
    action: { type: 'string', enum: ['sit', 'sleep', 'rest', 'work', 'eat', 'read', 'stand'] }, expectedRevision: { type: 'integer', minimum: 1 } }, ['operation']) },
  { name: 'companion_contact', description: '按当前用户明确请求联系真实伙伴，消息始终进入仅双方伙伴参加的独立私聊。“让GPT跟我说下午好”用destination=user，目标获得一次以本人身份向用户回复的宿主授权；你不能在目标与用户的私聊里发言。“你和GPT私下讨论”用peer。发送即自然产生伙伴私聊消息，无需用户另选双方。message仅本次最小必要请求，不复制无关私聊、历史或秘密，不代替目标编台词。', parameters: object({ companionId: string('伙伴目录中的目标ID', 160), destination: { type: 'string', enum: ['user', 'peer'] }, message: string('本次明确转达的最小必要请求，排除无关私聊资料', 4000) }, ['companionId', 'destination', 'message']) },
  { name: 'companion_reply_user', description: '当前伙伴私聊带有peerContact.responseDestination=user-direct时，用自己的话向用户发出获准的一条真实消息。宿主绑定接收人、原始请求和你自己的用户私聊；不能指定其他会话或替其他伙伴发言。普通伙伴讨论没有此授权。成功即已送达用户，不在伙伴私聊里重复整段用户回复，也不假称只是转达。', parameters: object({ message: string('你本人对用户的自然回复，仅含本次请求必要内容', 24000) }, ['message']) },
  { name: 'message_peer', description: '显式向当前群或伙伴交流里另一位已有伙伴发送文字、真实表情或当前聊天已分享文件。私聊中用户想联系其他伙伴时用companion_contact，不要声称无法联系。可以只发attachmentIds；继承活动预算与衍生轮次，不向自己反射，不要反复互相回应。', parameters: object({ companionId: string('当前会话中的目标伙伴ID', 200), content: { type: 'string', maxLength: 8000 }, attachmentIds: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 160 } } }, ['companionId']) },
];

// The model receives concise operational descriptions. The complete contracts
// above remain the application catalog; scope/authorization rules live in the
// stable system contract and host checks, rather than repeated in every tool.
const routerDescriptions: Record<string, string> = {
  agent_state: '读取自己持续主脑的事件序列及当前受众获准的任务协调状态；元数据不授予新权限。',
  dsh_task_result_read: '按taskId分页读本会话本人任务的完整结果。摘要为预览时沿nextOffset继续；只读，不重新执行。',
  context_handoff_read: '分页读当前受众的完整历史交接摘要或尾部原件；不可跨伙伴或受众。',
  chat_read_message: '按当前会话消息ID分页读取原文；长trigger用sourceMessageId回读，沿nextOffset继续。',
  chat_list_stickers: '查询本聊天真实表情包和表情ID，发送前先确认可用ID。',
  chat_send_sticker: '按真实stickerId向当前聊天发表情，可附caption；成功回执后不重复填充正文。',
  chat_list_files: '查询当前聊天已登记附件的真实ID和名称；不访问其他聊天或资产库。',
  chat_send_file: '发送已分享attachmentId或自身taskId内真实相对path。默认按文件版本去重；用户明确要求重发才resend。',
  agent_memory_scopes: '分页列本伙伴获准记忆会话，不启动VCP。用户私聊可列本人和用户参与的direct/group，其他频道仅当前域。',
  memory_search: '语义查长期记忆，默认本域；用户私聊可选scope目录conversationId，跨域只读、带来源，unavailable不等于没有记忆。',
  memory_recall_details: '按本轮citationId读取被动召回的完整证据；省略ID列引用，按nextOffset分页，不重新检索。',
  memory_history: '按具体关键词回查原始聊天；默认本域，用户私聊可选获准conversationId，跨域须来源可核实。',
  memory_read: '列出或读历史片段；默认本域，用户私聊可选获准conversationId，unavailable不等于没有历史。',
  memory_write: '保存明确事实、偏好、承诺或更正，带时间、适用范围和不确定性；不把猜测当用户事实。',
  memory_list: '分页查日记ID/预览/checksum，默认本域；用户私聊可选获准conversationId，再memory_note读全文，跨域仅只读。',
  memory_note: '按日记ID读全文与checksum；默认本域，用户私聊可选获准conversationId，跨域只读且不可据此跨域写改。',
  memory_update: '用刚读到的checksum更新整篇日记；保留来源、作者、更正经过，conflict重读，pending不称已可召回。',
  memory_organize: '以当前checksum整理2至16篇已读日记，保留事实差异和来源；partial/pending如实说明，不重复提交。',
  memory_forget: '仅在用户明确要求时按稳定ID撤回记忆及来源衍生使用；不会物理删除原聊天日志。',
  memory_maintenance: 'plan生成待审整理/梦境候选，status查进展；不能自行批准，日常周期由宿主安排。',
  dsh_task: '委派真实电脑工作，含目录、文件、研究、代码和脚本。传原始目标、授权和约束；返回编号仅表示提交，等待真实报告。',
  dsh_task_control: '管理本人任务：list/status查询，send指导，answer绑定原questionId，cancel停止，pause/resume_paused暂停继续，continue续输出检查点；unknown先核实。批量/删除操作需用户请求。',
  world: '观察、移动、旅行或家具交互，只控制自己；移动接受不等于到达，不能进入别人的私人小屋。',
  companion_contact: '用户明确请求时联系真实伙伴，始终投递双方独立私聊。destination=peer讨论，user请求对方本人向用户回复；仅转达必要内容。',
  companion_reply_user: '在收到宿主授权的伙伴转达后，以自己身份向用户私聊发消息；不可自选目的地、伪造授权或重复发送。',
  message_peer: '向同房真实伙伴发送文字、表情或当前已分享附件；继承活动预算，不自反、不无限互谢。跨房联系用companion_contact。',
};
function conciseToolSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(conciseToolSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => !(key === 'description' && typeof item === 'string'))
    .map(([key, item]) => [key, key === 'properties' && item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).map(([name, schema]) => [name, conciseToolSchema(schema)])) : conciseToolSchema(item)]));
}
export const BOT_ROUTER_TOOLS: BotDshTool[] = BOT_TOOLS.map(tool => ({ ...tool,
  description: routerDescriptions[tool.name] ?? tool.description, parameters: conciseToolSchema(tool.parameters) as BotDshTool['parameters'] }));
