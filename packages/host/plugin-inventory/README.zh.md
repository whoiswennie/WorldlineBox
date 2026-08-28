# @deepseek-ai/dsh-host-plugin-inventory

[English](README.md) | 中文

本包是本地功能页的 Host 权威。`PluginInventoryGateway` 投影实时 Cordis Loader Tree，并通过默认 Agent Preset 的常驻 Scope，以当前 Workspace `cwd` 解析 Skill。由此得到的分层 Catalog 与默认 Session 发现一致，而不只是 Root Registry。受保护的 Remote Method 负责列出、启用、禁用和删除本地项。

Loader 与 Skill 生命周期变化会发出经认证的 `plugin-inventory/change` 通知。目录 Resource Base 以 Host 解析后的路径返回，因此 Client 可以通过现有 Workspace 权威路由“打开文件夹”，无需导入文件系统 API。

`toolchains` Remote 在 Host Service 启动时捕获 Python、Node.js 与 Git 就绪状态。它只返回规范化版本与可用性标志；可执行文件路径和环境值留在 Host。当 `PATH` 中没有独立 `node` 命令时，内置 Node Runtime 是打包 Desktop 的 Fallback。

插件启用状态与删除记录持久化到 Profile 的 `local-extensions.json` Overlay，并通过正常 Cordis 重组生效。随包 Bundle 保持不可变。所有 `@deepseek-ai/dsh-*`、`@deepseek-ai/*`、`cordis:*` 和关键 Bootstrap Row 都受系统保护；Host 边界会同时拒绝其启用状态变更与删除。

Skill 启用状态是持久化的发现可见性 Override。删除只允许文件系统支持的 Project、User 与 Custom Skill Source，并拒绝以文件系统根目录为目标。

本包没有在线 Marketplace、包下载或 Registry 发现路径。

## 模型体验

无；Host Gateway 只向经认证的产品 Client 暴露清单与生命周期操作。

#### KV Cache 影响

清单快照与修改不增加请求 token；任何后续模型上下文变化由被启用或禁用的插件负责。

## 已知限制与延后工作

- **仅限本地来源**——Gateway 无法从在线 Registry 发现、下载、更新或恢复包。
