import type { useBotCallVoice } from './useBotCallVoice';
import { BotIcon } from './BotIcon';

export function BotCallVoiceControls({ voice, zh, onStart, onEdit, mode = 'status', inputActive = false, hideErrorDetail = false }: {
  voice: ReturnType<typeof useBotCallVoice>; zh: boolean; onStart(): void; onEdit(text: string): void;
  mode?: 'toolbar' | 'status'; inputActive?: boolean; hideErrorDetail?: boolean;
}) {
  if (!voice.available) return null;
  const { state } = voice;
  if (mode === 'toolbar') return <button className="bot-call-continuous-toggle" type="button" aria-label={zh ? '连续语音对话' : 'Continuous voice conversation'} aria-pressed={state.enabled} disabled={inputActive} title={inputActive ? zh ? '先关闭录音或转写面板' : 'Close the recording or dictation panel first' : zh ? '连续语音对话' : 'Continuous voice conversation'} onClick={state.enabled ? voice.stop : onStart}><BotIcon name="phone" /><span>{zh ? '连续语音' : 'Voice chat'}</span></button>;
  const labels = {
    off: zh ? '开启后，说完即发送' : 'Speak to send when enabled',
    preparing: zh ? '正在准备麦克风与本地识别…' : 'Preparing microphone and local recognition…',
    listening: zh ? '正在聆听 · 停顿后发送' : 'Listening · pause to send',
    recognizing: zh ? '正在识别你说的话…' : 'Recognizing your speech…',
    waiting: zh ? '等待伙伴回应…' : 'Waiting for your companion…',
    speaking: zh ? '伙伴正在说话 · 麦克风已暂停' : 'Your companion is speaking · microphone paused',
    error: zh ? '语音已暂停，仍可打字交流' : 'Voice paused · you can still type',
  };
  return <section className={`bot-call-voice is-${state.phase}`} aria-label={zh ? '会面语音对话' : 'Voice conversation'}>
    <div className="bot-call-voice-status" role="status"><span className="bot-call-voice-meter" aria-hidden="true" style={{ opacity: state.phase === 'listening' ? 1 : .3 }}>{[.6, 1, .8, 1, .6].map((weight, index) => <i key={index} style={{ transform: `scaleY(${.18 + voice.level * weight * .82})` }} />)}</span><span>{labels[state.phase]}</span></div>
    {state.phase === 'listening' && <button type="button" onClick={voice.finish}>{zh ? '说完了' : 'Done speaking'}</button>}
    {state.phase === 'speaking' && <button type="button" onClick={voice.interrupt}>{zh ? '打断并说话' : 'Interrupt and speak'}</button>}
    {state.phase === 'error' && <div className="bot-call-voice-error" role={hideErrorDetail ? undefined : 'alert'}>{!hideErrorDetail && <><p>{state.error}</p>{state.transcript && <blockquote>{state.transcript}</blockquote>}</>}<div>{state.canRetrySend && <button onClick={voice.retry}>{zh ? '重试发送' : 'Retry sending'}</button>}{state.canRetrySend && state.transcript && <button onClick={() => { voice.stop(); onEdit(state.transcript!); }}>{zh ? '改用文字编辑' : 'Edit as text'}</button>}<button onClick={voice.interrupt}>{zh ? '继续说话' : 'Speak again'}</button></div></div>}
  </section>;
}
