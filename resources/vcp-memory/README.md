# WorldlineBox 内置 VCP 记忆

伙伴聊天由应用启动独立的 Node 工作进程加载 VCP 记忆组件。应用随包提供工作进程、Rust 索引、聊天数据服务与向量模型。向量请求使用 WorldlineBox 的内置多模态模型。每个记忆空间分别存放日记、向量索引和历史话题。

本次移植的后端来自 VCPToolBox 提交 `fd1eec0d`，聊天上下文与历史记忆来自 VCPChat 提交 `ea8942cf`。各文件的来源、许可证和 SHA-256 收录在 `upstream/`。引擎的日记召回、训练和上下文预处理逻辑可在此处直接对照上游。 [VCPToolBox](https://github.com/lioensky/VCPToolBox/tree/fd1eec0dfe25507c22a42232b4b64cac8c0c7768) · [VCPChat](https://github.com/lioensky/VCPChat/tree/ea8942cfbe275bbe7fca1cbf1222f6c0ca0b3fe4)

开发环境与安装包使用同一个暂存流程。从项目根目录运行 `node scripts/stage-bot-memory.mjs` 准备资源，再用 `node scripts/verify-bot-memory.mjs` 检查资源与本机 ABI。 [集成说明](INTEGRATION.md)
