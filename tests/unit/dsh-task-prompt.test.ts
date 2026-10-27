import { expect, it } from 'vitest';
import { compileDshTaskPrompt } from '../../src/main/dsh/task-prompt';

it('keeps task context and exact constraints without leaking host evidence metadata', () => {
  const original = '只处理表情包。\n不要修改源文件；先检查格式，无法转换时报告原因。';
  const prompt = compileDshTaskPrompt({ prompt: '把指定 WebP 转成 GIF，输出到 output。' }, {
    task: { instructions: '保留动画并检查帧数。', context: { text: '已检查文件头，实际格式为 WebP。', files: ['C:\\素材\\喵.gif'] }, delivery: { format: 'text', requirements: ['报告最终路径和帧数'] } },
    constraints: [{ id: 'internal-id', sourceMessageId: 'internal-message-id', sourceDigest: 'a'.repeat(64), revision: 7, kind: 'source_requirements', text: original }],
  });
  for (const text of [original, '保留动画并检查帧数。', '实际格式为 WebP', 'C:\\素材\\喵.gif', '报告最终路径和帧数']) expect(prompt).toContain(text);
  for (const text of ['Host-verified', 'Delivery format: text', 'internal-id', 'internal-message-id', 'sourceDigest', 'a'.repeat(64), 'revision']) expect(prompt).not.toContain(text);
});

it('omits empty delivery boilerplate and duplicate text while retaining later amendments in order', () => {
  const prompt = compileDshTaskPrompt({ prompt: '只读列出文件' }, { task: { instructions: '只读列出文件', delivery: { format: 'text' } }, constraints: [
    { id: 'one', sourceMessageId: 'source', text: '只读列出文件' },
    { id: 'two', sourceMessageId: 'amendment', text: '改为仅列第一层，不递归。', kind: 'source_requirements' },
    { id: 'three', sourceMessageId: 'amendment', text: '改为仅列第一层，不递归。', kind: 'source_requirements' },
    { id: 'four', sourceMessageId: 'latest', text: '另一个任务的转码工作由其他伙伴处理。', kind: 'source_requirements' },
  ] });
  expect(prompt.match(/只读列出文件/gu)).toHaveLength(1);
  expect(prompt.match(/改为仅列第一层，不递归。/gu)).toHaveLength(1);
  expect(prompt.indexOf('改为仅列第一层')).toBeLessThan(prompt.indexOf('另一个任务'));
  expect(prompt).not.toContain('交付格式'); expect(prompt).toContain('不扩展本次目标');
  expect(compileDshTaskPrompt({ prompt: '完成目标' }, { task: { delivery: { format: 'text' } } })).toBe('完成目标');
});

it('preserves JSON and artifact acceptance requirements and rejects oversized context without truncation', () => {
  const schema = { type: 'object', required: ['count'] }, artifacts = [{ path: 'output.gif', minBytes: 12 }];
  const prompt = compileDshTaskPrompt({ prompt: '转换文件' }, { task: { delivery: { format: 'json', jsonSchema: schema, artifacts } } });
  expect(prompt).toContain('有效的 JSON'); expect(prompt).toContain(JSON.stringify(schema)); expect(prompt).toContain(JSON.stringify(artifacts));
  expect(() => compileDshTaskPrompt({ prompt: '执行任务' }, { constraints: Array.from({ length: 5 }, (_, index) => ({ id: String(index), sourceMessageId: 'source', text: String(index) + '中'.repeat(15000) })) })).toThrow('not truncated');
});
