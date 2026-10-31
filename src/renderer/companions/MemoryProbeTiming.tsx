import type { CompanionMemoryProbeStageId, CompanionMemoryProbeStageTiming } from '../../shared/companion-memory-probe-progress';
import type { CompanionMemoryProbe } from '../../shared/companion-memory-probe';
import { Icon } from '../Icons';

export interface MemoryProbeTimingView {
  state: 'running' | 'completed' | 'failed';
  totalMs: number;
  backendTotalMs?: number;
  stageId?: CompanionMemoryProbeStageId;
  label?: string;
  stageElapsedMs?: number;
  backendState?: 'running' | 'completed' | 'failed';
  stages: CompanionMemoryProbeStageTiming[];
}
const stageOrder: CompanionMemoryProbeStageId[] = ['preparation', 'queue', 'sources', 'runtime', 'projection', 'retrieval', 'focus', 'verification'];
function stageLabel(id: CompanionMemoryProbeStageId, mode: CompanionMemoryProbe['mode']) {
  const labels: Record<CompanionMemoryProbeStageId, string> = { preparation: '准备回忆服务', queue: '等待查询队列', sources: '核验记忆来源',
    runtime: '连接记忆引擎', projection: '同步记忆索引', retrieval: mode === 'active' ? '候选检索与准备' : '准备原版话题检索',
    focus: '原版检索与片段整理', verification: '检查来源与文件' };
  return labels[id];
}
function duration(ms: number) {
  if (ms < 1_000) return `${Math.round(Math.max(0, ms))} 毫秒`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${((ms % 60_000) / 1_000).toFixed(1)} 秒`;
}

export function MemoryProbeTiming({ timing, mode }: { timing: MemoryProbeTimingView; mode: CompanionMemoryProbe['mode'] }) {
  const values = new Map(timing.stages.map(stage => [stage.id, stage]));
  const observed = stageOrder.flatMap(id => values.has(id) ? [{ ...values.get(id)!, id }] : []);
  const longest = observed.reduce<CompanionMemoryProbeStageTiming | undefined>((best, stage) => !best || stage.elapsedMs > best.elapsedMs ? stage : best, undefined);
  const live = timing.state === 'running', phaseRunning = live && timing.backendState === 'running';
  const backendEnded = timing.backendState === 'completed' || timing.backendState === 'failed';
  const currentLabel = !timing.stageId ? '等待回忆服务响应' : timing.backendState === 'completed' && live ? '后端处理完成，等待结果返回'
    : timing.backendState === 'failed' && live ? '后端处理已停止，等待返回' : timing.label || stageLabel(timing.stageId, mode);
  return <section className={'memory-probe-timing is-' + timing.state} aria-label="本次回忆耗时" data-probe-timing-state={timing.state}>
    <header><div><span className="memory-probe-timing-icon"><Icon name={live ? 'clock' : timing.state === 'failed' ? 'alert-circle' : 'check'} size={18} /></span>
      <span><strong>{live ? '正在回忆' : timing.state === 'failed' ? '本次回忆已停止' : '本次回忆用时'}</strong><small>从点击开始，到结果返回</small></span></div>
      <div className="memory-probe-timing-total"><span>总用时</span><output aria-label="等待总用时" data-probe-total-ms={Math.round(timing.totalMs)}>{duration(timing.totalMs)}</output></div></header>
    {live ? <div className="memory-probe-current-stage"><div><span className="memory-probe-stage-dot" /><p role="status">{currentLabel}</p></div>
      {timing.stageElapsedMs !== undefined ? <span>{backendEnded ? '最后后端环节' : '本环节'} <output aria-label={backendEnded ? '最后后端环节用时' : '当前阶段用时'}>{duration(timing.stageElapsedMs)}</output></span> : <span>环节计时等待服务确认</span>}</div>
      : timing.state === 'failed' && timing.stageId && <p className="memory-probe-timing-stopped">最后观测环节：{stageLabel(timing.stageId, mode)}</p>}
    <div className="memory-probe-timing-backend"><span>后端处理</span>{timing.backendTotalMs === undefined ? <span>尚未提供</span>
      : <output aria-label="后端处理用时" data-probe-backend-ms={Math.round(timing.backendTotalMs)}>{duration(timing.backendTotalMs)}</output>}
      {!live && timing.backendTotalMs !== undefined && timing.totalMs > timing.backendTotalMs + 1 && <small>连接与返回等待约 {duration(timing.totalMs - timing.backendTotalMs)}</small>}</div>
    <table className="memory-probe-timing-table" aria-label="实际阶段耗时"><thead><tr><th scope="col">执行环节</th><th scope="col">状态</th><th scope="col">累计用时</th></tr></thead><tbody>
      {stageOrder.map(id => {
        const stage = values.get(id), current = phaseRunning && timing.stageId === id;
        const slowest = !live && stage && longest?.id === id && stage.elapsedMs > 0;
        const failed = timing.backendState === 'failed' && timing.stageId === id;
        return <tr key={id} data-memory-probe-stage={id} className={[current ? 'is-current' : '', slowest ? 'is-longest' : '', !stage ? 'is-unobserved' : ''].filter(Boolean).join(' ')}>
          <th scope="row">{stageLabel(id, mode)}{slowest && <span className="memory-probe-longest-badge" aria-label="最慢阶段">最慢</span>}</th>
          <td>{!stage ? '未观测' : current ? '进行中' : failed ? '已停止' : '已记录'}</td>
          <td>{stage ? <><span className="memory-probe-stage-bar" aria-hidden="true"><i style={{ width: `${longest?.elapsedMs ? Math.min(100, stage.elapsedMs / longest.elapsedMs * 100) : 0}%` }} /></span><span>{duration(stage.elapsedMs)}</span></> : '未提供'}</td>
        </tr>;
      })}
    </tbody></table>
    <p className="memory-probe-timing-note">阶段来自本次实际执行，重复进入同一环节会累计。候选检索包含候选准备；原版处理可能包含检索、片段整理和模型聚焦。</p>
  </section>;
}
