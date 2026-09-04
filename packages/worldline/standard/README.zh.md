# 世界线标准

[English](README.md) | 中文

本包负责项目存储、编译器、演算工作线程、Host 服务和 Client 共享的可移植 WWS 契约。它定义稳定标识、来源、地图、世界蓝图、行动、过程、事件流、记忆、AI 用量遥测、上下文包、叙事投影、证书、检查点与回放记录，同时不绑定题材。

## 契约

运行时状态只能通过已验证的行动与世界事件改变；诊断和叙事记录不能伪装成世界事实。导入器只接受当前应用自有格式，并拒绝不兼容数据，不为旧格式分叉兼容逻辑。

## OC 项目框架

`WORLDLINE_PROJECT_LAYOUT` 是唯一的当前目录契约。原生创建流程先选择对象类型，再由该契约决定
Markdown 存储目录；档案馆使用同一组类型和分组，保证创作端与阅览端不会分裂。

| 创作内容 | 正典类型 | 目录 |
| --- | --- | --- |
| 世界宪章 | `charter` | `canon/` |
| 人物与物种 | `character`、`species` | `characters/`、`species/` |
| 空间 | `place` | `maps/places/` |
| 社会结构 | `organization`、`relation` | `organizations/`、`relations/` |
| 世界知识 | `rule`、`concept`、`fact` | `mechanisms/`、`concepts/`、`facts/` |
| 物品与媒体目录 | `item`、`asset` | `items/`、`assets/catalog/` |
| 剧情与历史 | `scenario`、`timeline-event` | `scenarios/plot-points/`、`timelines/` |
| 二进制媒体 | — | `assets/files/` |

`.worldline/` 控制树由应用管理，保存元数据、版本历史、构建、Run 快照、回收站与传输状态。
这些派生或受管记录永远不成为创作正典，恢复存档也不会改写 Markdown 真源。

## 模型体验

间接影响，由消费者选择 WWS 值并放入提示词、工具结果或模型请求。

#### KV 缓存影响

类型与校验包本身不发起模型请求；内容顺序和缓存稳定性由消费者负责。

## 已知限制与后续工作

- **应用自有交换格式** — WWS 不是外部标准，因此其他工具生成的归档必须按照仓库当前契约显式校验。
