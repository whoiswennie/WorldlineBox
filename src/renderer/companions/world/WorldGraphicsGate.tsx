import type { WorldGraphicsCapability } from '../../../shared/world-graphics-capability';
import { Icon } from '../../Icons';
import './world-graphics-gate.css';

export function WorldGraphicsGate({ report, checking, onRecheck }: { report?: WorldGraphicsCapability; checking: boolean; onRecheck(): void }) {
  return <section className="world-graphics-gate" aria-label="3D 设备能力" role="status">
    <span className="world-graphics-gate-symbol"><Icon name={checking ? 'loader' : 'box'} size={24} /></span>
    <h3>{checking ? '正在检测 3D 基础能力' : '3D 画面暂不可用'}</h3>
    <p>{checking ? '检查本地 WebGL 2 与内存信息，不运行性能测试。' : report?.reason ?? '尚未完成本机图形检测。'}</p>
    {!checking && <><p className="world-graphics-gate-detail">仍可查看右侧的生活状态。聊天、记忆文档与资产管理可以继续使用。</p><button type="button" onClick={onRecheck}><Icon name="refresh" size={15} />重新检测 3D 能力</button></>}
  </section>;
}
