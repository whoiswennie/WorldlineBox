import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { botCallGestures, botCallModelCatalog, botCallModelRegistry, botCallMotionId, botCallVtsParameter, type BotCallModel, type BotCallSegment, type BotCallStage } from '../../shared/companion-call';
import { botPortraitPerformance, type BotPerformanceCopy } from '../../shared/bot-portrait-performance';

const modelReferences = z.object({ FileReferences: z.object({
  Expressions: z.array(z.object({ Name: z.string(), File: z.string() })).default([]),
  Motions: z.record(z.string().min(1).max(120), z.array(z.object({ File: z.string(), FadeInTime: z.number().optional(), FadeOutTime: z.number().optional() }))).default({}),
}) });
const parameterId = z.string().min(1).max(160);
const expressionFile = z.object({ Parameters: z.array(z.object({ Id: parameterId })), IsModelCustomizationExpression: z.boolean().optional() });
const vtsModel = z.object({
  ParameterSettings: z.array(z.unknown()).max(150).optional(),
  Hotkeys: z.array(z.unknown()).max(200).optional(),
});
const vtsHotkey = z.object({ Name: z.string().trim().min(1).max(160), Action: z.enum(['ToggleExpression', 'TriggerAnimation']), File: z.string() });
const motionFile = z.object({ Meta: z.object({ Duration: z.number().nonnegative() }),
  Curves: z.array(z.object({ Id: parameterId, Target: z.string() })) });
const animationFile = /\.(exp3|motion3)\.json$/iu;
const idleFile = /(?:^|[\s/_.-])idle(?:[\s/_.-]|$)|待机/iu;

function localReference(file: string): string | undefined {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//u, '');
  return normalized.length <= 240 && !/[:?#%\0]/u.test(normalized)
    && normalized.split('/').every(part => part && part !== '.' && part !== '..') ? normalized : undefined;
}

async function discoverFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  const files: string[] = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) files.push(...(await discoverFiles(path.join(directory, entry.name), depth + 1)).map(file => entry.name + '/' + file));
    else if (entry.isFile() && (animationFile.test(entry.name) || /\.vtube\.json$/iu.test(entry.name))) files.push(entry.name);
    if (files.length >= 256) return files.slice(0, 256);
  }
  return files;
}

export async function readBotCallModel(root: string | undefined, companionId: string): Promise<BotCallModel | undefined> {
  if (!root) return;
  try {
    const base = await realpath(root);
    const read = async (file: string) => {
      const absolute = await realpath(path.join(base, file));
      const relative = path.relative(base, absolute);
      if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw Error('Model asset is outside the call directory.');
      return JSON.parse(await readFile(absolute, 'utf8')) as unknown;
    };
    const registry = botCallModelRegistry.parse(await read('models.json'));
    if (!Object.hasOwn(registry, companionId)) return;
    const entry = registry[companionId]!;
    const folder = path.posix.dirname(entry.model), inModel = (file: string) => path.posix.join(folder, file);
    const { FileReferences: references } = modelReferences.parse(await read(entry.model));
    const configured = entry.catalog ? botCallModelCatalog.safeParse(await read(entry.catalog).catch(() => undefined)).data : undefined;
    const files = await discoverFiles(path.join(base, folder)).catch(() => []);
    const vtsCandidates = files.filter(file => /\.vtube\.json$/iu.test(file));
    const vts = entry.vts ?? (vtsCandidates.length === 1 ? inModel(vtsCandidates[0]!) : undefined);
    const vtsConfig = vts ? vtsModel.safeParse(await read(vts).catch(() => undefined)).data : undefined;
    const vtsParameters = vtsConfig?.ParameterSettings?.flatMap(value => {
      const mapping = botCallVtsParameter.safeParse(value);
      return mapping.success ? [mapping.data] : [];
    });
    const hotkeys = vtsConfig?.Hotkeys?.flatMap(value => {
      const hotkey = vtsHotkey.safeParse(value);
      return hotkey.success ? [hotkey.data] : [];
    }) ?? [];
    const aliases = (file: string, name: string, action: z.infer<typeof vtsHotkey>['Action']) => {
      const basename = path.posix.basename(file);
      return [...new Set(hotkeys.filter(item => {
        if (item.Action !== action || item.Name === name) return false;
        const reference = localReference(item.File);
        return reference === file || reference === basename && files.filter(candidate => path.posix.basename(candidate) === basename).length === 1;
      }).map(item => item.Name))];
    };
    const expressions: BotCallModel['assets']['expressions'] = [];
    const motions: BotCallModel['assets']['motions'] = [];
    const manifest: NonNullable<BotCallModel['manifest']> = { Expressions: [], Motions: Object.create(null) };
    const parsed = async (file: string) => read(inModel(file)).catch(() => undefined);
    const expressionPaths = new Set<string>(), motionPaths = new Set<string>();
    for (const item of [...references.Expressions, ...files.filter(file => file.toLowerCase().endsWith('.exp3.json')).map(File => ({ File, Name: path.posix.basename(File).slice(0, -10) }))]) {
      const file = localReference(item.File);
      if (!file || !item.Name || item.Name.length > 160 || expressionPaths.has(file) || expressions.some(value => value.name === item.Name)) continue;
      const data = expressionFile.safeParse(await parsed(file)).data;
      if (!data) continue;
      expressionPaths.add(file);
      manifest.Expressions.push({ Name: item.Name, File: file });
      const labels = aliases(file, item.Name, 'ToggleExpression');
      expressions.push({ file, name: item.Name, params: [...new Set(data.Parameters.map(item => item.Id))],
        ...(labels.length ? { aliases: labels } : {}), ...(data.IsModelCustomizationExpression ? { customization: true } : {}) });
      if (expressions.length >= 100) break;
    }
    const addMotion = async (group: string, ref: { File: string; FadeInTime?: number; FadeOutTime?: number }, discovery: boolean) => {
      const file = localReference(ref.File);
      if (!file || motions.length >= 100 || (discovery && motionPaths.has(file))) return;
      const data = motionFile.safeParse(await parsed(file)).data;
      if (!data || !data.Meta.Duration) return;
      motionPaths.add(file);
      const target = discovery ? (idleFile.test(file.toLowerCase()) ? 'Idle' : 'Interaction') : group;
      const items = manifest.Motions[target] ??= [];
      const index = items.length;
      items.push({ ...ref, File: file, FadeInTime: ref.FadeInTime ?? .25, FadeOutTime: ref.FadeOutTime ?? .3 });
      const name = configured?.motions.find(item => item.file === file)?.name ?? path.posix.basename(file).slice(0, -13);
      const labels = aliases(file, name, 'TriggerAnimation');
      motions.push({ file, group: target, index, duration: data.Meta.Duration, name,
        params: [...new Set(data.Curves.filter(curve => curve.Target === 'Parameter').map(curve => curve.Id))],
        ...(labels.length ? { aliases: labels } : {}) });
    };
    for (const [group, refs] of Object.entries(references.Motions)) for (const ref of refs) await addMotion(group, ref, false);
    for (const File of files.filter(file => file.toLowerCase().endsWith('.motion3.json'))) await addMotion('', { File }, true);
    const assets = botCallModelCatalog.parse({ expressions, motions, credits: configured?.credits ?? '', license: configured?.license ?? '' });
    return { ...entry, assets, manifest, vtsParameters };
  } catch { return undefined; } // A missing/invalid model still supports portrait and text.
}

const dafeiyuExpressions: Readonly<Record<string, BotPerformanceCopy>> = {
  兔牙: ['露出兔牙，适合淘气一笑。', 'Show buck teeth for a mischievous grin.'],
  前倾: ['靠近一点，适合好奇或认真听。', 'Lean closer in curiosity or to listen.'],
  加载: ['思路暂时卡住时的喜剧效果。', 'A comic beat for getting momentarily stuck.'],
  圈圈眼: ['被突如其来的信息绕晕时。', 'For comic confusion or dizziness.'],
  屑屑眼: ['熟人间无伤大雅的揶揄。', 'A cheeky look for friendly teasing.'],
  流冷汗: ['被问住或略显尴尬时。', 'For an awkward moment or being caught off guard.'],
  流泪: ['失而复得、伤心或感动落泪时。', 'For tears of relief, sadness, or affection.'],
  爱心眼: ['看到特别喜欢的事物时短暂使用。', 'A short beat of delight at something she loves.'],
  脸红: ['被真诚夸奖或不好意思时。', 'For sincere praise or bashfulness.'],
  黑脸: ['夸张表现一时无语或被吓到。', 'A comic reaction to dismay or shock.'],
  '＞＜': ['害羞、轻微受惊或忍笑时的挤眼。', 'Squeeze eyes shut in bashfulness, surprise, or amusement.'],
  单片眼镜: ['切换单片眼镜，适合角色换装。', 'Switch on the monocle as a costume change.'],
  黑框眼镜: ['切换黑框眼镜，适合角色换装。', 'Switch on the black glasses as a costume change.'],
  体型1: ['切换到第一种预设体型。', 'Switch to the first body preset.'],
  体型2: ['切换到第二种预设体型。', 'Switch to the second body preset.'],
  默认体型: ['恢复模型默认体型。', 'Restore the default body preset.'],
  尾巴开关: ['切换鲸尾可见性。', 'Toggle visibility of the whale tail.'],
  胸口衣服: ['切换衣装预设。', 'Toggle the clothing preset.'],
  裙子切换: ['切换裙装长度预设。', 'Switch the skirt length preset.'],
  脱鞋: ['切换鞋子外观。', 'Toggle the footwear.'],
  钢盆: ['切换钢盆道具。', 'Toggle the bowl prop.'],
  竖食指开: ['用食指强调一个具体重点。', 'Raise a finger to emphasize one point.'],
  竖食指关: ['结束强调，收回食指。', 'Lower the finger after an emphasized point.'],
};
const dafeiyuMotions: Readonly<Record<string, BotPerformanceCopy>> = {
  IDLE: ['自然待机，由舞台自动安排。', 'Ambient motion played automatically by the stage.'],
  默认手切举手: ['手抬到胸前，适合认真承诺或表达谢意。', 'Raise a hand to the chest for a promise or sincere thanks.'],
  举手切默认手: ['把胸前的手放回默认位置。', 'Lower the raised hand back to rest.'],
  竖手指切出来动画: ['抬起食指，适合提示一件关键事项。', 'Raise an index finger to highlight one key point.'],
  竖手指切回默认: ['结束提示，收回食指。', 'Lower the raised finger after the point.'],
  狗尾草切换出来: ['拿出狗尾草道具，适合轻松逗趣。', 'Bring out the foxtail grass prop for playful moments.'],
  狗尾草切回默认手: ['收回狗尾草道具。', 'Put away the foxtail grass prop.'],
  脱捕: ['恢复追踪时的模型过渡。', 'A model transition used when leaving tracking.'],
};

export function botCallCapabilities(model: BotCallModel | undefined, companionId = ''): BotCallStage {
  if (!model) {
    const portrait = botPortraitPerformance(companionId);
    return {
      mode: 'portrait',
      expressions: portrait.expressions.map(({ id, label, description }) => ({ name: id, label, description })),
      motions: portrait.motions.map(({ id, label, description }) => ({ id, name: label[0], label, description })),
      gestures: [],
    };
  }
  const authored = companionId === 'builtin-dafeiyu';
  return {
    mode: 'live2d',
    model: model.model,
    catalog: model.catalog,
    expressions: model.assets.expressions.map(({ name, file, params, aliases, customization }) => ({ name, file, parameters: params,
      ...(aliases ? { aliases } : {}), ...(customization ? { customization } : {}),
      ...(authored && Object.hasOwn(dafeiyuExpressions, name) ? { description: dafeiyuExpressions[name] } : {}) })),
    motions: model.assets.motions.map(item => ({ id: botCallMotionId(item), name: item.name, file: item.file, durationSeconds: item.duration,
      parameters: item.params, idle: /^idle$/iu.test(item.group), ...(item.aliases ? { aliases: item.aliases } : {}),
      ...(authored && Object.hasOwn(dafeiyuMotions, item.name) ? { description: dafeiyuMotions[item.name] } : {}) })),
    gestures: botCallGestures,
  };
}

export function validateBotCallPerformance(stage: BotCallStage, segments: readonly BotCallSegment[]): void {
  for (const [index, segment] of segments.entries()) {
    if (segment.expression && !stage.expressions.some(item => item.name === segment.expression)) throw Error(`第 ${index + 1} 段表情无效。用 call_stage 查当前伙伴目录后，使用 expressions[].name 重新提交。`);
    if (segment.motion && !stage.motions.some(item => item.id === segment.motion)) throw Error(`第 ${index + 1} 段动作无效。用 call_stage 查当前伙伴目录后，使用 motions[].id 重新提交。`);
    if (segment.gesture && !stage.gestures.includes(segment.gesture)) throw Error(`第 ${index + 1} 段手势无效。用 call_stage 查当前形象支持的 gestures 后重新提交。`);
  }
}
