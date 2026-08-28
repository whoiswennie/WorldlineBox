# WorldlineBox 知识库

[English](README.md) | 中文

这里是 WorldlineBox 的架构事实源。代码定义行为，本文档定义包之间必须长期保持的职责、依赖方向、生命周期和验证方式。

## 阅读顺序

1. [总体架构](architecture.md)：运行时分层、核心服务和依赖方向。
2. [Cordis 插件模型](cordis-primer.md)：Context、Service、inject、事件、effect 和 Fiber。
3. [能力接缝](capability-seams.md)：Service Definition、Provider、Consumer 的完整能力族。
4. [Profile 与 Bundle](profiles-and-bundles.md)：应用如何由配置组合，而不是由入口硬编码。
5. [Host/Client 边界](host-client-boundary.md)：Node/Electron 与浏览器之间的类型和信任边界。
6. [Session 与 Turn 生命周期](session-turn-lifecycle.md)：模型输入、工具执行和持久化事实的来源。
7. [防御性生命周期](defensive-patterns.md)：并发、取消、回滚和资源释放规则。
8. [测试与质量门禁](testing-and-quality.md)：什么证据能够证明一个 Harness 改动完成。
9. [世界线、素与幻](worldbuilding.md)：项目的原创世界观基础，以及它与技术架构的关系。

## 架构不变量

- 一切产品能力通过 Cordis 插件装配；应用入口只选择组合和管理进程生命周期。
- 扩展依赖 Service Definition，不依赖具体 Provider；Bundle 是唯一允许选择实现的层。
- 注册必须归属于 Fiber：使用 `ctx.effect()`、`ctx.on()` 或内部已绑定调用 Context 的 registry。
- 模型可见的信息必须写入 Session Event Log，并能从日志重建。
- Host 持有文件、进程、凭据和网络权限；Client 只通过生成的 Remote 与显式事件访问。
- 每个包必须有 `./invariant` 伴生入口，或明确说明没有独立运行时关系可验证。
- 配置错误在最早可判断的位置失败，不允许静默降级为另一种权限或 Provider。
