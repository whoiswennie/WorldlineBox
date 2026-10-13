import { describe, expect, it } from 'vitest';
import { resolveCompanionTaskIntent } from '../../src/main/companions/task-intent';
import { shouldDelegateUserMessage } from '../../src/main/companions/model';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion, CompanionMessage } from '../../src/shared/companions';
const roles = BUILTIN_COMPANIONS.map(role => ({ ...role, builtin: true, createdAt: '' })) as Companion[];
const message = (sequence: number, content: string, authorId = 'user'): CompanionMessage => ({
  id: 'm' + sequence, sequence, conversationId: 'group', authorId, content, kind: 'text', status: 'sent', attachments: [], createdAt: '',
});
describe('Natural tasks and contextual continuations', () => {
  it.each(['几点了', '看看现在几点了', '你帮我搜一下最近的新闻', '搜索今天的新闻', '请帮我写一个十章的小说'])('recognizes a task without requiring a harness command: %s', content => {
    expect(shouldDelegateUserMessage(content)).toBe(true);
  });
  it('addresses the named character and resolves 看呗 against the actual earlier user goal', () => {
    const request = message(1, '大肥鱼看看现在几点了');
    const intent = resolveCompanionTaskIntent([request, message(2, '我看看。', 'deepseek-sister'), message(3, '看呗')], roles, []);
    expect(intent).toMatchObject({ source: { id: request.id }, title: '查看当前时间', addressedId: 'deepseek-sister' });
    expect(intent?.prompt).toContain(request.content);
  });
  it('resolves 都行 after a news clarification, but never replays an already registered task', () => {
    const messages = [message(1, '你帮我搜一下最近的新闻'), message(2, '哪方面？', 'deepseek-flash'), message(3, '都行')];
    expect(resolveCompanionTaskIntent(messages, roles, [])?.prompt).toContain('综合新闻');
    expect(resolveCompanionTaskIntent(messages, roles, [{ sourceMessageId: 'm1' } as never])).toBeUndefined();
  });
  it.each(['我最近想整理照片', '只讨论，帮我搜一下新闻', '这是小说台词：请帮我查资料', '请不要执行工具', '看呗'])('does not invent a task from %s', content => {
    expect(resolveCompanionTaskIntent([message(1, content)], roles, [])).toBeUndefined();
  });
  it('does not reuse an old request across an intervening unrelated user message', () => {
    expect(resolveCompanionTaskIntent([message(1, '帮我搜新闻'), message(2, '收到', 'deepseek-flash'), message(3, '今天心情很好'),
      message(4, '很开心', 'deepseek-flash'), message(5, '好呀')], roles, [])).toBeUndefined();
  });
});
