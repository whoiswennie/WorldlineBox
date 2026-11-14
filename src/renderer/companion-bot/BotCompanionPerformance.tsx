import { useEffect, useState } from 'react';
import type { WorldlineBoxBotApi } from '../../shared/companion-bot';
import { botCallGestureDescriptions, botCallGestureLabels, type BotCallStage, type BotCallStageChoice, type BotCallStageMotion } from '../../shared/companion-call';
import { BotIcon } from './BotIcon';

export function BotCompanionPerformance({ api, companionId, locale }: { api: WorldlineBoxBotApi; companionId: string; locale: 'zh-CN' | 'en' }) {
  const [stage, setStage] = useState<BotCallStage>(), [error, setError] = useState(false);
  const zh = locale === 'zh-CN', language = zh ? 0 : 1;
  useEffect(() => {
    let active = true;
    void api.request({ type: 'companion.call-performance', companionId }).then(result => {
      if (!active) return;
      if (result.ok && result.callStage) setStage(result.callStage);
      else setError(true);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [api, companionId]);
  const groups: Array<{ title: string; icon: 'smile' | 'full-body'; choices: readonly (BotCallStageChoice | BotCallStageMotion)[] }> = stage ? [
    { title: zh ? '情绪与表情' : 'Emotions & expressions', icon: 'smile', choices: stage.expressions },
    { title: zh ? '动作' : 'Motions', icon: 'full-body', choices: stage.motions },
  ] : [];
  return <section className="bot-settings-scroll bot-settings-performance">
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
  </section>;
}
