# 开发者文档

面向要在本地开发 WorldlineBox、或成为项目贡献者的人：环境搭建、架构、测试、打包与贡献流程。这些页面随 `main` 发布，不是 `docs/internal/` 里的切片日志或内部规格。

开发者文档分两部分：

## 第一部分：软件开发

面向参与 WorldlineBox 本身开发的开发者：架构、源码构建、测试规范。

- [环境搭建](setup.md)——依赖、首次构建、开发环境
- [构建与打包](build-packaging.md)——package / make / 发布流水线 / 签名
- [架构](architecture.md)——进程模型、目录结构、关键设计
- [应用侧边栏](application-navigation.md)——功能模块登记、状态保留与设置入口
- [Serpent 0.3.2 增量升级](serpent-032-upgrade/README.md)——来源清单、自有功能适配、配置迁移和验收
- [Serpent 0.3.3 资产管理升级](serpent-033-upgrade/README.md)——模型双面与透明贴图、浏览刷新、路径快捷键及自有功能边界
- [伙伴消息系统](companions.md)——独立 SQLite owner、角色模型连接、记忆与 DSH 行动回流
- [VCP 记忆实施说明](companion-memory-implementation.md)——统一资产库、自然文本日记、原版检索、持续生活及内置多模态向量
- [伙伴系统验收](companion-system-acceptance.md)——三伙伴、持续生活、授权学习、消息气泡与安装包的实际验证边界
- [VCP 记忆内容审计](vcp-memory-content-audit.md)——原版源码信息流、真实模型内容测试、修复和额外调用成本
- [VCP 记忆完整替换调研](research-vcp-memory-replacement.md)——以 VCP 替换无 Embedding 占位方案的源码清单、宿主边界及验证
- [DSH 启动器](dsh-launcher.md)——固定运行时、实例隔离、进程监督、快照与离线备份
- [DSH 整合包格式](dsh-packs-format.md)——依赖封存、来源锁与导入校验
- [测试](testing.md)——测试体系与运行方式
- [新增媒体格式支持](media-format-support.md)——从共享注册表到导入、预览、过滤、协议和验收
- [分支与开发工作流](workflow.md)——分支策略、开源贡献流程与维护者工作纪律
- [贡献指南](contributing.md)——开源协作、Pull Request 与代码门禁要求
- [贡献者名单](https://github.com/whoiswennie/WorldlineBox/blob/dev/CONTRIBUTORS.md)——已被项目接受并合并的贡献列表

其他软件文档（内部记录仅仓库 `dev` 分支，网站不发布）：

- [开发流程](https://github.com/whoiswennie/WorldlineBox/blob/dev/docs/internal/development-process.md)——切片流程与质量门禁
- [领域模型](https://github.com/whoiswennie/WorldlineBox/blob/dev/docs/internal/domain-model.md) / [术语表](../glossary.md)
- [架构决策记录](https://github.com/whoiswennie/WorldlineBox/tree/dev/docs/internal/adr)——ADR-0000 起
- [实施规格](https://github.com/whoiswennie/WorldlineBox/tree/dev/docs/internal/implementation)——切片规格

## 第二部分：扩展开发

面向编写插件、脚本、MCP 适配器的开发者。**不需要了解软件架构**，直接看[扩展作者手册](../manual/README.md)：

- [插件开发指南](../manual/plugins/development.md) + [最佳实践](../manual/plugins/best-practices.md) + [API 参考](../manual/plugins/api-reference.md)
- [插件分发与更新](../manual/plugins/distribution-and-updates.md)
- 官方插件参考实现：
  - [WorldlineBox-Plugin-Renamer](https://github.com/dolag233/WorldlineBox-Plugin-Renamer)——非受限模式（`unrestricted`），基于 Host 标准对话框与列表控件实现资产批量重命名与实时改动预览
  - [WorldlineBox-Plugin-MediaConverter](https://github.com/dolag233/WorldlineBox-Plugin-MediaConverter)——媒体转码与压缩扩展，演示多规格媒体计划、后台 Job 队列任务生命周期与全平台包分发（`any`）
  - [WorldlineBox-Plugin-ImageUpscaler](https://github.com/dolag233/WorldlineBox-Plugin-ImageUpscaler)——非受限模式（`unrestricted`），演示外部 AI 推理二进制文件管理、跨平台独立 ZIP 分流打包发布（`darwin-arm64` / `win32-x64`）与分块内容回写
- [脚本开发指南](../manual/scripts/development.md) + [API 参考](../manual/scripts/api-reference.md)
- [MCP 开发指南](../manual/mcp/development.md) + [API 参考](../manual/mcp/api-reference.md)

最终用户使用插件的方法见[插件使用](../user-guide/plugins.md)，浏览器扩展见[浏览器扩展](../user-guide/browser-extension.md)，自动化脚本和 MCP 见[自动化功能](../user-guide/automation.md)。
