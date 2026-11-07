import { expect, it } from 'vitest';
import { buildBotTaskPrompt, type BotHandoffFile } from '../../src/main/companion-bot/task-handoff';

const sourcePath = 'C:\\task\\.worldlinebox\\task-input.json';
it('passes complete independent task requirements through exactly, including long text and constraints', () => {
  for (const goal of ['查询上海未来72小时降雨；附数据来源，不修改文件。', '完整要求\n' + '必要的范围与约束。'.repeat(2400) + '\n末尾：禁止删除原件']) {
    expect(buildBotTaskPrompt({ goal, files: [], sourcePath })).toBe(goal);
  }
});

it('adds only selected file evidence without host bookkeeping or original request boilerplate', () => {
  const file: BotHandoffFile = { id: 'host-private-id', name: '截图.png', mimeType: 'image/png', size: 8, sha256: 'a'.repeat(64), path: 'C:\\task\\attachments\\截图.png' };
  const prompt = buildBotTaskPrompt({ goal: '识别图片，只读。', files: [file], sourcePath });
  expect(prompt).toContain(file.path.replaceAll('\\', '\\\\')); expect(prompt).toContain(file.sha256);
  for (const value of ['host-private-id', sourcePath, '用户原始要求', '相关聊天上下文', '完整原始请求', '伙伴交接的目标']) expect(prompt).not.toContain(value);
});

it('references a large selected file manifest without truncating the task requirements or blocked-file warning', () => {
  const files: BotHandoffFile[] = Array.from({ length: 16 }, (_, index) => ({ id: String(index), name: '附件' + index,
    path: 'C:\\task\\' + '长目录'.repeat(600) + index + '.bin', mimeType: 'application/octet-stream', size: 500 }));
  const goal = '完整目标：逐个核验附件，不修改原件。';
  const prompt = buildBotTaskPrompt({ goal, files, sourcePath });
  expect(prompt.startsWith(goal)).toBe(true); expect(prompt).toContain(sourcePath); expect(prompt).not.toContain('已截断');
  const blocked = buildBotTaskPrompt({ goal, files: [{ ...files[0]!, path: 'C:\\task\\large.bin', analysisBlocked: true, previewLimitReason: '超过安全读取上限' }], sourcePath });
  expect(blocked).toContain('超过安全读取上限'); expect(blocked).toContain('"analysisBlocked":true');
});
