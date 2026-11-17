import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { botCallCapabilities, readBotCallModel, validateBotCallPerformance } from '../../src/main/companion-bot/call-models';
import { importLocalCallModel, pruneLocalCallModelImports, readLocalCallModel, resetLocalCallModel, serveLocalCallModel } from '../../src/main/companion-bot/local-call-model';
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

it('loads folders per companion, keeps a working selection on failure, and restores the default', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-call-import-'));
  const profile = path.join(root, 'profile');
  const gpt = 'gpt', custom = 'companion-studio-test';
  const model = async (name: string) => {
    const wrapper = path.join(root, name);
    const folder = path.join(wrapper, 'Export');
    await mkdir(path.join(folder, '贴图'), { recursive: true });
    await mkdir(path.join(folder, 'expressions'));
    await Promise.all([
      writeFile(path.join(folder, name + '.model3.json'), JSON.stringify({
        Version: 3, FileReferences: { Moc: 'body.moc3', Textures: ['贴图\\face.png'] },
      })),
      writeFile(path.join(folder, 'body.moc3'), 'MOC3'),
      writeFile(path.join(folder, '贴图', 'face.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      writeFile(path.join(folder, 'expressions', 'smile.exp3.json'), JSON.stringify({ Parameters: [{ Id: 'ParamSmile' }] })),
    ]);
    return wrapper;
  };
  const request = (asset: string, modelUrl: string) => serveLocalCallModel(profile, new Request(new URL(asset, modelUrl)));
  try {
    const first = await model('舞台 A');
    const second = await model('舞台 B');
    await importLocalCallModel(profile, gpt, first);
    await importLocalCallModel(profile, custom, second);
    const original = (await readLocalCallModel(profile, gpt))!;
    expect(original).toMatchObject({ localImport: true, model: 'model/舞台 A.model3.json', assets: { expressions: [{ name: 'smile' }] } });
    expect((await request('贴图/face.png', original.modelUrl!)).status).toBe(200);
    expect((await request('../../active.json', original.modelUrl!)).status).toBe(404);
    await expect(importLocalCallModel(profile, gpt, path.join(first, 'Export', 'expressions'))).rejects.toThrow('找不到 .model3.json');
    expect(await readLocalCallModel(profile, gpt)).toMatchObject({ modelUrl: original.modelUrl });
    await importLocalCallModel(profile, gpt, second);
    expect(await readLocalCallModel(profile, gpt)).toMatchObject({ model: 'model/舞台 B.model3.json' });
    expect((await request('body.moc3', original.modelUrl!)).status).toBe(200);
    await resetLocalCallModel(profile, gpt);
    expect(await readLocalCallModel(profile, gpt)).toBeUndefined();
    expect(await readLocalCallModel(profile, custom)).toMatchObject({ model: 'model/舞台 B.model3.json' });
    await pruneLocalCallModelImports(profile);
    expect((await request('body.moc3', original.modelUrl!)).status).toBe(404);
    expect(await readLocalCallModel(profile, custom)).toBeDefined();
  } finally {
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('wlb-call-import-')) await rm(root, { recursive: true, force: true });
  }
});
