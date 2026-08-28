# 本地功能 UI

[English](README.md) | 中文

这个 Client 插件拥有主侧栏的“功能”入口。页面通过经认证的 Host Remote，读取当前 Profile 的插件清单，以及默认 Agent Preset 在当前 Workspace 下的 Skill Catalog，并支持本地启用、禁用和受保护的删除操作。

搜索完全在本地即时完成：每次输入变化都会对精确、前缀、子串、Token 和子序列匹配排序。Loader 与 Skill 事件自动刷新快照，并通过重连、窗口聚焦、可见性和定时器恢复。目录型 Skill 提供“打开文件夹”操作，由 Workspace Host API 路由。

本包不提供 Catalog、网络发现、npm/GitHub 搜索、下载、更新、恢复或 Electron Marketplace Bridge。Framework 插件显示为系统保护项，即使绕过 UI，Host 也会拒绝变更。Bundled 与 Runtime Skill 不可删除；只有文件系统支持的 Project、User 和 Custom Skill 可以删除。

因此基础侧栏只有三个产品入口：对话、功能和设置。功能页拥有 Runtime 发现与生命周期控制；设置中的插件区独立拥有可编辑配置 Schema、Draft、验证和持久化。

## 模型体验

无；页面读取和修改本地插件清单，不调用 Agent。

#### KV Cache 影响

清单渲染与生命周期操作不增加模型 token，也不改变现有请求前缀。

## 已知限制与延后工作

- **仅限本地清单**——Catalog 发现、包下载、更新、恢复与在线 Marketplace 操作不属于本包。
