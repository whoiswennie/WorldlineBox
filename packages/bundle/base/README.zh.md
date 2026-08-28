# @deepseek-ai/dsh-base

[English](README.md) | 中文

CLI、Desktop 与 Web Host 共用的 Cordis Profile Bundle。

## 模型体验

通过 Base Profile Patch 插入的面向模型插件间接影响模型。

#### KV Cache 影响

Bundle 本身不贡献 token；改变其组合行可能改变这些行所拥有的 Prompt 与工具前缀。

## 已知限制与延后工作

- **只负责组合**——本包插入基线行，但不配置部署专用 Provider、凭据或 Host 能力。
