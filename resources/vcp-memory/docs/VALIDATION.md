# 验证记录

2026-11-02，Windows x64，Node.js v22.19.0。源实现、独立适配器、真实提供方分别验证。完整能力对照见 [FEATURE_PARITY.md](FEATURE_PARITY.md)，分数和耗时的来源见 [CLI_DIAGNOSTICS.md](CLI_DIAGNOSTICS.md)。

| 验证 | 结果 | 可复现入口 / 证据 |
|---|---|---|
| 独立模块与 CLI | **55 通过，0 失败，0 跳过** | `npm test`；`reports/standalone-final.log` |
| ToolBox 原测试 | **359 通过，0 失败，89 跳过**，共448项 | `npm run test:upstream`；`reports/upstream-toolbox-repeat.log` |
| Chat 原测试，含原 DeepMemo adapter | **83 通过，0 失败，0 跳过** | 同上；`reports/upstream-chat-repeat.log` |
| 源码、原生二进制、权重与官网资料完整性 | **5份清单全部通过，无差异** | `npm run verify`；各文件 SHA256 见 `upstream/manifest*.json`、`references/official/manifest.json` |
| 真实 DeepSeek + 本地 Gemma + VCP 原生链路 | **12步通过** | `npm run test:live`；`reports/live-validation.json` |
| 真实文本、图片 Embedding | **通过**，768D、相关文本检索、图片跨模态输入 | `tests/local-embedding.integration.test.cjs` |
| 真实音频、视频 Embedding | **通过**，实际 typed 输入进入模型 | `node scripts/probe-local-modalities.cjs`；`reports/local-modalities-smoke.json` |
| Agent skill | **格式验证与独立使用测试通过** | `.agents/skills/vcp-memory/SKILL.md`；`docs/SKILL_EVALUATION.md` 及 JSON 证据 |

ToolBox 跳过项：87项属于未纳入本模块的其他第三方工具生态，2项依赖单独的实验 TDB validation 编译产物或旧 USearch 对照基线。没有把跳过项记成通过，也没有修改原测试来改变断言结果。

独立测试使用真实 Rust/SQLite/TriviumDB/CDS，并覆盖创建、摄取、重启、KNN/RiverMemo、限定日记范围与K、更新、删除、冷库、OneRing 完成记录、短期摘要、时间线、Magi/Dream、折叠异步落盘、RAG 流内刷新、角色变量边界、完整历史、分支、压缩、文件附件与并发工作区。可控 HTTP/向量夹具用于协议与算法执行测试，不作为生产语义质量证据。

真实远端联调使用用户配置的 DeepSeek 官方 `deepseek-flash`，Embedding 使用本包从 WorldlineBox 提取的 Gemma/llama.cpp CPU。验证实际对话、原 DailyNote、向量入库、限定范围 RiverMemo、OneRing 注入/响应记录、真实 OneRingMemo、真实 AIMemo+、同一长驻进程的会话追加与原 CDS 深度回忆。所有测试记忆都在临时空间中创建并清除；用户既有日记和聊天没有自动导入。

## 诊断保真

`tests/telemetry.test.cjs` 的7项测试，以及 ChatMemory 和实际 CLI 诊断测试验证：

- 同一次原方法只调用一次，不为诊断增加检索或重排请求。
- 原始候选的分数、排名与数组顺序保持不变，原返回对象/异常不被替换为自制评分结果。
- 原 Rust `includeTrace` 仅增加其已有的解释字段。同库、同查询、同候选、同观测句柄的开关对照中，`score`、`vectorScore`、`hybridScore`、`baseScore`、`topologyBonus`、`anchorBonus`、`omega`、`originalScore` 和排名严格相等。
- 原 Rust 耗时与宿主 `performance.now` 边界耗时分开，未提供的内部时间不按比例拆分。
- CDS/Tantivy 窗口得分与同一次外部 Rerank `relevance_score` 分开；源私有函数未暴露的重排后数组明确为 `null`，不倒推补算。

实际本地模型查询的完整原生解释样例保存在 `reports/live-diagnostics.json`。它保留 VCP 原生字段以及 `diagnosticOptions` 中的源解释开关记录，不是新建的一套评分公式。

## 可用入口

```powershell
cd C:\Users\hp\Desktop\project\new\vcp-memory
vcp-memory --home .\.vcp-memory doctor
vcp-memory --home .\.vcp-memory tool DailyNote --input .\examples\note.json
vcp-memory --home .\.vcp-memory sync
vcp-memory --home .\.vcp-memory search "ADR-017选择数据库的理由" --diary MemoryAgent --k 3 --diagnostics-file .\reports\my-query.json
```

CLI 已通过 `npm link` 注册，skill 已链接至本机 Codex skills 目录。DeepSeek 凭据只保存在本机忽略目录的工作区配置中；检查未在源码或报告中发现该凭据。模型、原生引擎、媒体运行时均已复制进本包，正常执行不依赖三个原项目的绝对源路径。原项目只读核对，ToolBox 原有 `docs/research/` 未跟踪目录保持原状。

## 验证边界

本次完成的是当前真实代码的独立可运行移植。上游 `AgentDream.approveDreamOperation/rejectDreamOperation` 本身是 `not_implemented`，没有伪造其功能；白皮书中尚无完整实证链路的采纳反馈自学习也没有标成通过。

所有 DSL 修饰器组合、超大规模/持续多日负载、长期自动梦境、真实 Anthropic/Gemini 服务、独立远端 Rerank/Jev 的质量，并未由这些测试穷尽。不能据此承诺所有输入和所有提供方下“百分百无缺陷”。当前分支保留完整源算法、配置能力、可复现测试和明确的未验证范围。
