# Profile、Bundle 与配置组合

[English](profiles-and-bundles.md) | 中文

## 组合顺序

最终插件树从空列表开始，按以下顺序应用：

1. 继承的 `@deepseek-ai/dsh-base` Bundle；
2. 形态 Bundle，例如 `@deepseek-ai/dsh-web-app` 或 `@deepseek-ai/dsh-headless`；
3. Profile 自身的 `cordis.patch.yml`；
4. Worldline Home 级补丁；
5. 命令行 `--patch` overlay。

后层可以替换已有行的配置、禁用行或插入新行。Worldline 的 Include 扩展还支持 `removed: true`，用于插件中心持久化删除本地扩展行。

## Bundle 职责

- `bundle/base` 选择跨形态通用服务、Provider、工具和策略。
- `bundle/web-app` 增加 Web Host、Client 图、认证、插件中心和桌面浏览能力。
- `bundle/headless` 关闭 Web/HMR，增加一次性任务入口。

Bundle 只拥有部署选择。服务实现仍在独立包中，用户 Patch 应能替换任何 Provider。

## Agent Preset

Agent Preset 是会话级 Cordis 组合。目前提供 `standard`、`code`、`cordis`、`minimal` 和 `virtual-companion`。Preset 选择模型可见的 Tools、Prompt、Skills 和 delegation 能力；进程级 Session、Jobs、Goals、Subagents 注册表仍在 Host 平面。虚拟伙伴 preset 以关系与陪伴为先：不可见的协调意志会从账户级伙伴通讯录中路由一位或多位当前房间成员，同时保留显式选择的公开账户资料上下文与网页检索，但不提供工作区或编码工具。

## 技术坐标

全部 Harness 包和世界线独有包都使用与 Harness 0.1.1-rc.1 对齐的 `@deepseek-ai/dsh-*` 技术坐标，以及 `dsh.bundle`、`dsh.client` 和 `dsh.profile` manifest 协议。运行时不再维护第二套包别名层。这些内部坐标不会改变世界线的运行时名称、CLI、Home 目录或 UI 品牌。
