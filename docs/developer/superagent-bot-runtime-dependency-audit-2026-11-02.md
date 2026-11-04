# 伙伴运行入口与退役依赖审计（2026-11-02）

本次为源码、当前 staging 的只读审计，未发模型请求，未删除文件。它不能代替最终构建后对新产物的 package 验收。

## 当前实际链路

- `src/main/index.ts:4977` 懒创建 `BotService + BotMemoryService + BotDshBrain`；新数据根为 userData 的 `companion-bot-v2`。SDK 使用 `launcher.botNodePath()`，开发包根为 `.tools/bot-memory-release/vcp-memory`，正式包根为 `process.resourcesPath/vcp-memory`，未使用 Electron 当 Node。
- 主进程仅注册新 `BOT_CHANNEL`；`src/preload/index.ts` 暴露新 `companionBot`，其 bridge 对请求做新 schema 校验；`Application.tsx` 加载 `companion-bot/BotWorkspace`。没有发现退役 cognition、旧 `companions/model`、旧 memory-startup 或 vcp-memory-host IPC / bootstrap import。
- `forge.config.ts` 通过 extraResource 单独复制新 staging，ASAR 排除 `.vite/vcp-memory*`；`verify-package.mjs` 明确拒绝旧 vcp-memory-host 和重复 ASAR 副本。生产依赖使用独立 Node 24 安装，不与 Electron 重编的根 better-sqlite3 混用。
- `prestart` 只 verify 既有 staging，不在应用每次启动或聊天时安装依赖。stage 只有源、闭包、ABI 不匹配时才更新，完全匹配则复用。

## 本次实际校验

`node scripts/verify-bot-memory.mjs` 通过：453 个源文件与 source / integration manifest 一致，246 个生产依赖闭包、Node 24.15.0 / ABI 137，实际原生 SQLite 和 Vexus 加载成功。原始完整性校验通过 336 + 32 + 26 + 7 + 4 = 405 个原始文件，独立 local-embedding 的 112 个复制资源按 managed 模式省略。

`resources/vcp-memory` 无 GGUF 权重、无 vendor/local-embedding、无 node_modules。实际模型仅位于应用既有 `resources/embedding-models`；宿主创建域时写入 `LOCAL_EMBEDDING_ENABLED:false`，动态注入带 token 的 loopback document/query bridge。运行实测模型为内置 EmbeddingGemma2 compact 768 维。记忆模块没有为聊天启动第二套权重下载。

## 保留项与边界

- `src/renderer/companions/MessageCodeBlock.tsx`、`MessageDiagram.tsx` 仍被通用浏览器 Markdown 使用；`companions/world/world-room-model.ts`、`world-park-model.ts` 被新世界场景使用。这些是仍在使用的渲染模块，应保留。
- `src/shared/model-companions.ts` 是 3D 模型关联纹理索引，由 Library Worker / 模型加载器使用，与旧 AI 伙伴无关，应保留。browser 目录的 companion viewport / screenshot / activity 同样属于浏览器操作能力。
- `src/main/companions`、`src/main/vcp-memory` 的旧目录为空，没有源文件和运行 import；它们不构成旧运行依赖。旧 e2e 命令名 `test:e2e:companions` / `test:e2e:companion-memory` 目前是新 Bot 测试的兼容入口，并未运行旧实现。
- 完整独立 VCP 保留 `lib/local-embedding.cjs`、CLI init 等通用能力，但应用入口明确禁用它，资源也不随新包复制。审计发现的 managed config 人为改成 `LOCAL_EMBEDDING_ENABLED:true` 边界已修复：BotMemoryService 对 boolean true / string true 显式返回 `MEMORY_MANAGED_EMBEDDING_REQUIRED`，在创建 Worker 之前拒绝，并且不静默改文件。实际原生 source-only 归档、关闭、改配置、重启拒绝测试已通过；没有创建第二个 Worker 或启动下载。独立通用 CLI 未改动。
- 原始 CDS 显式 status 仍会统计全历史，TopicMemo 仍读取完整 owner 目录；本轮把这些统计移出了零变更聊天回查路径，而非修改原生算法。UI 的普通 `state` snapshot 不调用 memory.status；只在显式 memory.inspect 时调用。
- 最新宿主改动已经 staging / 原生回归通过。最终发布包还需在这些改动之后重建、verify，不能把较早 package 产物当作最新源码的验证。

本审计未发现新主进程、preload、renderer 或打包链路继续依赖退役的 cognition / 资产库记忆实现。规模实测、仪表限制及证据目录见同日 `superagent-bot-memory-scale-2026-11-02.md`。
