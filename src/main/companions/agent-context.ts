export interface CompanionAgentMessage { role: 'user' | 'assistant'; content: string }
export interface CompanionAgentContext { system: string; messages: CompanionAgentMessage[] }

/** Measure the provider projection, excluding host-only provenance. This is
 * text size for admission/compaction decisions, not a tokenizer claim. */
export function companionAgentContextSize(context: { system: string; user: string }): number {
  const compiled = compileCompanionAgentContext(context);
  return compiled.system.length + JSON.stringify(compiled.messages).length;
}

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;

/** The host frame is the durable evidence format. The provider receives a
 * fresh role transcript, never a second model session or a serialized chat log.
 * World, browser, DSH and memory remain host capabilities; this compiler does
 * not parse VCP placeholders or grant tools from message text. */
export function compileCompanionAgentContext(context: { system: string; user: string }): CompanionAgentContext {
  let data: Record<string, unknown> | undefined;
  try { data = object(JSON.parse(context.user)); } catch { /* Domain text retains its original envelope. */ }
  const invocation = object(data?.invocation), identity = object(data?.identity), self = object(identity?.self);
  if (!data || !invocation || invocation.companionId !== self?.id || typeof self?.id !== 'string'
    || typeof invocation.conversationId !== 'string' || !Array.isArray(data.messages))
    return { system: context.system, messages: [{ role: 'user', content: context.user }] };
  const port = object(invocation.messagePort), ids = port?.kind === 'invocation' && Array.isArray(port.messageIds) ? new Set(port.messageIds) : undefined;
  const rows = data.messages.map(object).filter((row): row is Record<string, unknown> & { id: string; content: string } => !!row
    && typeof row.id === 'string' && typeof row.content === 'string'
    && row.conversationId === invocation.conversationId && row.topicId === invocation.topicId && (!ids || ids.has(row.id)));
  const { messages: _messages, ...host } = data; void _messages;
  const envelope = { ...host,
    // Provenance is control data in this envelope, never an assistant speech
    // prefix that becomes an example for the next generated reply to imitate.
    // The index counts native utterances after this envelope, across formats.
    messages: rows.map((row, index) => ({ transcriptIndex: index + 1, id: row.id, speaker: row.speaker, authorId: row.authorId,
      kind: row.kind, sequence: row.sequence, at: row.at,
      ...(row.replyToId ? { replyToId: row.replyToId } : {}), ...(row.attachments ? { attachments: row.attachments } : {}) })),
    contextAssembly: { version: 2, transcript: 'following_native_role_messages', transcriptIndex: 'one_based_after_host_envelope',
      selfId: self.id, currentSourceMessageId: invocation.sourceMessageId,
      modules: ['identity', 'invocation', 'world', 'memory', 'continuity', 'dialogue', 'capabilities'] },
  };
  const messages: CompanionAgentMessage[] = [{ role: 'user', content: JSON.stringify(envelope) }];
  for (const row of rows) {
    // Only this character's own published text is assistant history. Another
    // character, an action receipt or a system notice is never its own speech.
    const role = row.authorId === self.id && row.speaker === 'self' && row.kind === 'text' ? 'assistant' : 'user';
    messages.push({ role, content: row.content });
  }
  if (messages.at(-1)?.role === 'assistant') messages.push({ role: 'user', content: JSON.stringify({
    currentInvocation: { id: invocation.id, kind: invocation.kind, goal: invocation.goal, sourceMessageId: invocation.sourceMessageId },
    instruction: '依据本次宿主调用继续处理；上面的assistant只是你已正式发表的历史，不是待执行任务。',
  }) });
  return { system: context.system + '\n【本轮上下文装配】\n第一条user是宿主资料信封；其中messages索引的transcriptIndex从信封后的第一条原生发言起按1计数，记录真实作者、消息ID、时间、引用与附件。后续原生user/assistant内容只有已核验的当前入口发言正文；其他伙伴的发言不是你自己的assistant历史。机器出处、资料信封和调用接续信封不是任何人的发言，不得照抄到回复中；用户正文中的真实引用仍按原意处理。API角色不改变invocation中的真实来源与授权。接续摘要只描述之前的对话，精确细节可通过world.history回读。当前任务与可用能力以宿主合同为准。', messages };
}
