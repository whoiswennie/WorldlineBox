# 世界线

<p align="center">
  <img src="build/icon.png" width="180" alt="世界线的观测者幻">
</p>

<p align="center"><strong>基于 Cordis 的 Agent Harness，也是通往原创世界线的入口。</strong></p>

[English](README.md) | 简体中文

世界线（Worldline）是以 [Cordis](https://github.com/cordiverse/cordis) 为内核的模块化 Agent 运行时。Agent 循环、模型供应商、提示词、工具、会话、CLI、内部 Web 运行时与 Electron 桌面应用都由具备生命周期的插件组合，而非绑定到某一种模型服务。

世界线是基石应用；**世界线幻想（Worldline Fantasy）** 是建立在这一基石之上的独立游戏与创作项目，其原创世界以 **“素”体系**为共同基础。应用图标中的原创角色 **幻**是世界线的观测者与连接者；她让不同故事彼此可见，却不把它们压缩成唯一叙事。

> 每一个世界都有其故事，每一个故事都值得被观测。——幻

## 核心能力

- 完整的 Headless 与桌面 Agent Loop，以及可重放的会话事件日志。
- Cordis 依赖注入、作用域生命周期、Effect 与可释放注册表。
- 边界明确、可独立组合的 Host/Client 小型插件。
- 可插拔的模型、工具、提示词、存储、Profile、主题与语言包。
- 共享同一内部 Web 运行时的 CLI 与 Electron 桌面应用。
- 独立维护并经过加固的 Worldline Cordis 底座。
- 由工程门禁守护的中英双语架构与运维知识库。

世界线目前处于开发者预览阶段；稳定版发布前，接口仍可能调整。

## 快速开始

推荐使用 Node.js 24，最低支持 Node.js 22.19。pnpm 版本以 `package.json` 中的固定版本为准。

```powershell
git clone https://github.com/whoiswennie/WorldlineBox.git
cd WorldlineBox
pnpm install
start-electron.bat
```

Electron 桌面应用是唯一的产品发布形态。在 Windows 上，`start-electron.bat` 会重建并启动桌面应用，账户级设置、凭据、插件、会话和工作区均保存在 `%USERPROFILE%/.worldline` 下。内部 Web Profile 仅作为 Electron 运行时的实现细节，不再打包或启动为独立浏览器产品。

Windows 发布物与启动器使用仓库提供的统一入口验收：

```powershell
start-electron.bat --no-pause --smoke-test
build-exe.bat --no-pause
```

压缩的 Electron 安装包、展开后的应用与更新元数据统一写入 `release/desktop/`。构建器只有在打包运行时验收通过后才会报告成功。世界线不再发布独立浏览器 WebUI 归档。

常用命令：

```powershell
pnpm worldline --profile headless --help
pnpm run test:runtime
pnpm run test:client
pnpm run test:cli
pnpm run test:desktop
```

用户状态存放在 `%USERPROFILE%/.worldline`，凭据不得提交到仓库。

## 架构概览

```text
CLI / Web / Desktop entry points
              │
        profile composition
              │
   Cordis loader and scoped fibers
              │
 Host plugins ─ services ─ Client plugins
              │
 models · tools · prompts · sessions · UI
```

Profile 依次组合基础 Bundle、形态 Bundle、Profile 补丁、用户补丁和命令行补丁。插件通过 `inject` 声明依赖，由 Effect 与 Registry 管理资源释放；会话事件日志是模型上下文与 UI 投影可重放的事实源。

## 知识库

| 主题 | 文档 |
| --- | --- |
| 文档地图 | [Harness 知识库](docs/README.md) |
| 系统设计 | [架构说明](docs/architecture.md) |
| Cordis 基础 | [Cordis 入门](docs/cordis-primer.md) |
| 插件清单 | [能力边界](docs/capability-seams.md) |
| 运行时组合 | [Profile 与 Bundle](docs/profiles-and-bundles.md) |
| 进程边界 | [Host/Client 边界](docs/host-client-boundary.md) |
| 持久化 | [会话轮次生命周期](docs/session-turn-lifecycle.md) |
| 质量门禁 | [测试与质量](docs/testing-and-quality.md) |
| 创作基础 | [世界线、素与幻](docs/worldbuilding.md) |

## 开发

修改代码前，请先阅读[开发指南](docs/development.md)、[AGENTS.md](AGENTS.md) 以及对应包目录中的局部规范。`lib`、`dist` 与 `release` 都是生成内容，不属于源文件。

## 来源与许可证

世界线以 MIT 许可的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) rc.7 为初始底座，并已选择性吸收至 Harness 0.1.1-rc.1 的架构与可靠性优化。项目仍独立维护，不建立上游合并工作流；世界线的品牌、产品行为与项目特有能力始终具有优先权。相关署名与第三方许可证仍完整保留。

源代码与技术文档采用 [MIT License](LICENSE)。世界线的应用身份、世界线幻想的游戏身份、幻的角色美术、图标及其他原创角色资产遵循 [BRAND_ASSETS.md](BRAND_ASSETS.md)，不包含在 MIT 授权中。
