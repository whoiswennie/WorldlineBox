import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertCompanionExternalLearningSource } from '../../src/main/companions/learning-source-admission';
import { readGoalTextFile } from '../../src/main/companions/learning-goal-file';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-learning-ingress-')) throw new Error('Unexpected test root.');
  rmSync(root, { recursive: true, force: true });
} });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-learning-ingress-')); roots.push(root);
  const managed = path.join(root, 'companions'), outside = path.join(root, 'external'); mkdirSync(managed); mkdirSync(outside);
  return { root, managed, outside, policy: { managedRoots: [managed] }, signal: new AbortController().signal };
}
it('rejects every managed type including task references and unknown files without inferring authority from its name', async () => {
  const f = fixture();
  for (const relative of ['profile.md', '提示词/回复.md', '演化/起点/origin.md', '证据/历史/old.md', '演化/发布/pub.md', '.运行/引用/task.md', 'unknown.txt']) {
    const file = path.join(f.managed, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, '不能作为外部知识。');
    await expect(readGoalTextFile(file, f.signal, f.policy)).rejects.toThrow('不能经附件或资料入口');
  }
  const external = path.join(f.outside, 'profile.md'); writeFileSync(external, '外部教材文件名本身不授予或撤回类型。');
  expect((await readGoalTextFile(external, f.signal, f.policy)).content).toContain('外部教材');
});
it('preserves the original selected source boundary after copying to an attachment, including after original removal', async () => {
  const f = fixture(), source = path.join(f.managed, 'profile.md'), attachment = path.join(f.outside, 'attachment.txt'); writeFileSync(source, '受管人格。'); copyFileSync(source, attachment);
  const policy = { ...f.policy, sourcePath: source };
  await expect(readGoalTextFile(attachment, f.signal, policy)).rejects.toThrow('不能经附件或资料入口');
  unlinkSync(source); await expect(readGoalTextFile(attachment, f.signal, policy)).rejects.toThrow('不能经附件或资料入口');
});
it('fails closed without host roots and rejects hardlink aliases while allowing a genuinely independent external document', async () => {
  const f = fixture(), original = path.join(f.managed, 'profile.md'), alias = path.join(f.outside, 'alias.txt'); writeFileSync(original, '受管人格。'); linkSync(original, alias);
  await expect(assertCompanionExternalLearningSource(alias, f.policy)).rejects.toThrow('链接');
  const external = path.join(f.outside, 'book.txt'); writeFileSync(external, '可以实际读取并保留来源的独立外部材料。');
  await expect(assertCompanionExternalLearningSource(external, { managedRoots: [] })).rejects.toThrow('缺少宿主受管根');
  expect((await readGoalTextFile(external, f.signal, f.policy)).revision).toMatch(/^[a-f0-9]{64}$/u);
});
