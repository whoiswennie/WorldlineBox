import { useEffect, useState, type ReactNode } from 'react';
import type { WorldlineBoxBotApi } from '../../shared/companion-bot';
import type { WorldlineBoxShellApi } from '../../shared/external-url';
import { botCallGestureDescriptions, botCallGestureLabels, DAFEIYU_MODEL_DOWNLOAD, YACHIYO_MODEL_DOWNLOAD, type BotCallStage, type BotCallStageChoice, type BotCallStageMotion } from '../../shared/companion-call';
import { DEFAULT_BOT_COMPANION_ID, YACHIYO_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';
import { BotIcon } from './BotIcon';

export function BotCompanionPerformance({ api, companionId, locale, children }: { api: WorldlineBoxBotApi; companionId: string; locale: 'zh-CN' | 'en'; children?: ReactNode }) {
  const [stage, setStage] = useState<BotCallStage>(), [error, setError] = useState(false);
  const [pending, setPending] = useState<'import' | 'reset'>(), [modelError, setModelError] = useState('');
  const [changed, setChanged] = useState<'import' | 'reset'>();
  const zh = locale === 'zh-CN', language = zh ? 0 : 1;
  const yachiyo = companionId === YACHIYO_BOT_COMPANION_ID;
  const download = yachiyo ? YACHIYO_MODEL_DOWNLOAD : companionId === DEFAULT_BOT_COMPANION_ID ? DAFEIYU_MODEL_DOWNLOAD : undefined;
  const modelName = stage?.model?.split('/').at(-1)?.replace(/\.model3\.json$/iu, '');
  useEffect(() => {
    let active = true;
    void api.request({ type: 'companion.call-performance', companionId }).then(result => {
      if (!active) return;
      if (result.ok && result.callStage) setStage(result.callStage);
      else setError(true);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [api, companionId]);
  const changeModel = async (action: 'import' | 'reset') => {
    setPending(action); setModelError(''); setChanged(undefined);
    try {
      const result = await api.request({ type: action === 'import' ? 'call.model.import' : 'call.model.reset', companionId });
      if (!result.ok) throw Error(result.error || undefined);
      if (result.callStage) { setStage(result.callStage); setError(false); setChanged(action); }
    } catch (reason) {
      setModelError(reason instanceof Error && reason.message ? reason.message : zh ? '无法更新会面模型，请重试。' : 'Could not update the meeting model. Try again.');
    } finally { setPending(undefined); }
  };
  const groups: Array<{ title: string; icon: 'smile' | 'full-body'; choices: readonly (BotCallStageChoice | BotCallStageMotion)[] }> = stage ? [
    { title: zh ? '情绪与表情' : 'Emotions & expressions', icon: 'smile', choices: stage.expressions },
    { title: zh ? '动作' : 'Motions', icon: 'full-body', choices: stage.motions },
  ] : [];
  return <>
    <section className="bot-settings-scroll bot-call-model-settings" aria-label="Live2D">
      <div className="bot-settings-card" aria-busy={!!pending}>
        <h4>{zh ? 'Live2D 会面模型' : 'Live2D meeting model'}</h4>
        {stage && <p>{stage.mode === 'live2d'
          ? (zh ? `当前模型：${modelName ?? 'Live2D'}` : `Current model: ${modelName ?? 'Live2D'}`)
          : zh ? '当前使用静态形象。' : 'Currently using a portrait.'}</p>}
        <p>{zh ? '选择含 .model3.json 的模型文件夹。导入后，下次进入会面会自动加载。' : 'Choose a model folder containing a .model3.json file. The model loads automatically in your next meeting.'}</p>
        <div className="bot-call-model-actions">
          <button type="button" disabled={!!pending || (!stage && !error)} onClick={() => void changeModel('import')}>{pending === 'import' ? (zh ? '正在导入…' : 'Importing…')
            : stage?.mode === 'live2d' ? (zh ? '更换模型文件夹' : 'Replace model folder') : (zh ? '导入模型文件夹' : 'Import model folder')}</button>
          {stage?.localImport && <button type="button" disabled={!!pending} onClick={() => void changeModel('reset')}>{zh ? '恢复默认形象' : 'Restore default appearance'}</button>}
          {download && stage?.mode === 'portrait' && <a href={download} onClick={event => {
            const shell = (window as Window & { worldlinebox?: { shell?: WorldlineBoxShellApi } }).worldlinebox?.shell;
            if (!shell) return;
            event.preventDefault();
            void shell.openExternalUrl(download);
          }}>{zh ? '作者发布页' : 'Creator’s release'}</a>}
        </div>
        {changed && <p role="status" className="bot-settings-saved">{changed === 'import'
          ? zh ? '模型已导入。' : 'Model imported.'
          : zh ? '已恢复默认形象。' : 'Default appearance restored.'}</p>}
        {modelError && <p role="alert">{modelError}</p>}
      </div>
    </section>
    {children}
    <section className="bot-settings-scroll bot-settings-performance">
    <header className="bot-settings-section-heading">
      <h3>{zh ? '情绪、表情与动作' : 'Emotions, expressions & motions'}</h3>
      {stage && <p>{stage.mode === 'live2d' ? zh ? '从当前 Live2D 模型读取。伙伴会根据语境选择并播放。' : 'Read from the current Live2D model and played when appropriate.'
        : zh ? '这位伙伴的会面表演预设。选中的表情和动作会随台词显示在头像下方。' : 'This companion’s meeting cues appear with the dialogue beneath the portrait.'}</p>}
    </header>
    {error && <p role="alert">{zh ? '暂时无法读取表演目录。' : 'Could not load the performance catalog.'}</p>}
    {!stage && !error && <p role="status">{zh ? '正在读取表演目录…' : 'Loading the performance catalog…'}</p>}
    {groups.map(({ title, icon, choices }) => <div className="bot-settings-card" key={title}>
      <h4><BotIcon name={icon} />{title}</h4>
      {choices.length ? <dl>{choices.map(item => <div key={'id' in item ? item.id : item.name}>
        <dt>{item.label?.[language] ?? item.aliases?.[0] ?? item.name}</dt>
        <dd>{item.description?.[language] ?? (zh ? '由当前模型资源提供。' : 'Provided by the current model.')}</dd>
      </div>)}</dl> : <p>{zh ? '当前模型没有此类资源。' : 'No resources of this type in the current model.'}</p>}
    </div>)}
    {!!stage?.gestures.length && <div className="bot-settings-card">
      <h4>{zh ? '轻量手势' : 'Quick gestures'}</h4>
      <dl>{stage.gestures.map(gesture => <div key={gesture}><dt>{botCallGestureLabels[gesture][language]}</dt><dd>{botCallGestureDescriptions[gesture][language]}</dd></div>)}</dl>
    </div>}
    </section>
  </>;
}
