import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { botCallCapabilities, readBotCallModel, validateBotCallPerformance } from '../../src/main/companion-bot/call-models';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';

it('discovers VTS animations and parameters without a catalog, while preserving declared motion indices', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-call-model-'));
  const write = async (name: string, data: unknown) => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data));
  };
  try {
    const motion = { Meta: { Duration: 2.5 }, Curves: [{ Target: 'Parameter', Id: 'AngleX' }, { Target: 'Model', Id: 'Opacity' }] };
    await Promise.all([
      write('models.json', { test: { model: 'model/test.model3.json' } }),
      write('model/test.model3.json', { FileReferences: { Motions: { Wave: [{ File: 'wave.motion3.json' }] },
        Expressions: [{ Name: 'Invalid', File: '../outside.exp3.json' }] } }),
      write('model/idle/呼吸.motion3.json', motion),
      write('model/wave.motion3.json', motion),
      write('model/raise.motion3.json', motion),
      write('model/smile.exp3.json', { Parameters: [{ Id: 'Smile' }] }),
      write('outside.exp3.json', { Parameters: [{ Id: 'Wrong' }] }),
      write('model/test.vtube.json', { ParameterSettings: [{ Input: 'FaceAngleX', OutputLive2D: 'AngleX', OutputRangeLower: -30, OutputRangeUpper: 30 }],
        Hotkeys: [{ Name: 'Friendly smile', Action: 'ToggleExpression', File: 'smile.exp3.json' },
          { Name: 'Raise a hand', Action: 'TriggerAnimation', File: 'raise.motion3.json' },
          { Name: 'Unrelated', Action: 'ToggleExpression', File: '../outside.exp3.json' }] }),
    ]);
    const model = await readBotCallModel(root, 'test');
    const capabilities = botCallCapabilities(model);
    expect(capabilities.expressions).toEqual([{ name: 'smile', file: 'smile.exp3.json', parameters: ['Smile'], aliases: ['Friendly smile'] }]);
    expect(capabilities.motions.map(item => item.id)).toEqual(['Wave:0', 'Idle:0', 'Interaction:0']);
    expect(capabilities.motions[1]).toMatchObject({ parameters: ['AngleX'], durationSeconds: 2.5, idle: true });
    expect(capabilities.motions[2]).toMatchObject({ aliases: ['Raise a hand'], idle: false });
    expect(model?.manifest?.Motions.Idle?.[0]?.File).toBe('idle/呼吸.motion3.json');
    expect(model?.vtsParameters?.[0]?.OutputLive2D).toBe('AngleX');
    expect(() => validateBotCallPerformance(capabilities, [{ text: '你好', expression: 'smile', motion: 'Interaction:0' }])).not.toThrow();
    expect(() => validateBotCallPerformance(capabilities, [{ text: '你好', expression: 'reserved-smile' }])).toThrow('表情无效');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('gives every built-in a distinct portrait catalog and rejects cross-character or invented cues', () => {
  const profiles = BUILTIN_BOT_COMPANIONS.map(companion => botCallCapabilities(undefined, companion.id));
  expect(new Set(profiles.map(profile => profile.expressions[0]?.name)).size).toBe(profiles.length);
  for (const profile of profiles) {
    expect(profile.expressions.every(item => item.label?.every(Boolean) && item.description?.every(Boolean))).toBe(true);
    expect(profile.motions.every(item => item.label?.every(Boolean) && item.description?.every(Boolean))).toBe(true);
    expect(() => validateBotCallPerformance(profile, [{ text: '回应', expression: profile.expressions[0]!.name, motion: profile.motions[0]!.id }])).not.toThrow();
    expect(() => validateBotCallPerformance(profile, [{ text: '回应', motion: 'invented' }])).toThrow('动作无效');
  }
  expect(() => validateBotCallPerformance(botCallCapabilities(undefined, 'claude'), [{ text: '回应', motion: 'measured-nod' }])).toThrow('动作无效');
});
