# vcp-memory

从 VCPToolBox 与 VCPChat 已捕获的真实源码快照提取的独立记忆与上下文模块。原始检索、存储、记忆数学和上下文算法保存在 `upstream/`，适配层提供 CLI、JSONL 和 Node API。原项目的日记、聊天、配置与密钥不会自动导入。

源码快照、可调用能力和真实模型联调分别记录验证证据；请看 `docs/FEATURE_PARITY.md` 与各审计/测试报告。上游尚未实现的接口不会被描述为可用功能。

当前验收：独立测试55/55、上游原测试442通过/89跳过、真实DeepSeek与本地模型12步联调通过。详见 [验证记录](docs/VALIDATION.md)。

## 安装与工作区

要求 Node.js 22.19+。当前 Windows x64 已提供原始 Rust 二进制；其他平台以所附二进制或 Rust 源构建为准。

```powershell
cd C:\Users\hp\Desktop\project\new\vcp-memory
npm ci
npm link
vcp-memory --home .\.vcp-memory init
vcp-memory --home .\.vcp-memory doctor
vcp-memory verify
vcp-memory catalog
```

每个 `--home` 是一个独立数据空间，默认当前目录下 `.vcp-memory`。CLI 为每个空间串行加锁；多个 agent 可共享同一个 `serve` 会话或依次调用。包内源码是只读快照；插件需要写缓存、SQLite 或配置的相邻路径时，使用 `<home>/runtime` 的独立运行副本。

## 模型配置

默认对话提供者是 DeepSeek 的 OpenAI Chat Completions 接口，可替换 OpenAI 兼容服务；Anthropic Messages 与 Gemini 的文本摘要转换见 `docs/PROVIDERS.md`。本地 Embedding 使用从 WorldlineBox 提取的真实 Gemma 多模态模型与 llama.cpp；具体启动和模型资源见本地 Embedding 文档。对话模型与 Embedding 使用不同路由，配置不会把 DeepSeek 对话模型当成 Embedding。

在 `<home>/config.json` 配置提供者，密钥留在此本机运行目录，勿写进源码。原 VCP 的 env 配置键也能透传。`probe` 会真正调用 Embedding，`doctor` 不会消费远端模型额度。

## 日记与检索

把以下 JSON 保存为 `note.json`：

```json
{"command":"create","maid":"Agent","folder":"Agent","Date":"2026-11-02","Content":"决定用独立记忆工作区保存项目决策。","Tag":"项目决策,记忆系统"}
```

```powershell
vcp-memory tool DailyNote --input note.json
vcp-memory sync
vcp-memory search "项目记忆如何保存"
vcp-memory search "项目记忆" --diary Agent --knn
vcp-memory search "项目记忆" --diary Agent --k 3 --diagnostics-file .\query-diagnostics.json
```

`DailyNote` 的创建/更新队列、`DailyNoteManager` 的列出/整理/联想，以及 `LightMemo` 的检索模式均使用原实现。`catalog` 输出原 manifest 和命令说明，避免猜测参数。`sync` 会验证文件完整入库，Embedding 失败不能作为同步成功返回。

CLI 默认输出 `telemetry`，用于查看 VCP 原始阶段诊断、候选与排序分数。字段名、数值和候选顺序保持源返回值；外层计时单独标作 host timing，不补造内部阶段时间，不增加新的评分公式。`--no-diagnostics` 关闭采集，`--diagnostics-file` 另外保存 JSON。详细来源映射见 `docs/CLI_DIAGNOSTICS.md`。

## 上下文与会话

```json
{"messages":[{"role":"system","content":"[[OneRing::Agent::CLI]]\n[[Agent日记本]]"},{"role":"user","content":"回忆项目决策"}],"options":{"folding":true}}
```

把上面的请求交给 `preprocess --input request.json`。返回的 `messages` 可发给模型；返回的 `metadata` 要保留。模型响应后执行 `response --input response.json`，请求包含原 `messages`、`metadata`、`text` 与 `completed`，让 OneRing 完成响应记录；取消时用 `completed:false`。

`session` 命令维护完整聊天历史、检查点、分支快照和知识结晶。历史压缩保留原始历史，只有发送给模型的有效上下文改变。`context prepare` 使用 VCPChat 原请求构造器并生成时间戳绑定，显式传入附件路径可使用原文件处理器。`context/session auto-compact` 按原85%阈值判断是否压缩；`compact` 与 `auto-compact` 默认继承工作区模型提供方。详细命令见 `--help` 和 `docs/AUDIT_CONTEXT.md`。

历史聊天回忆使用 `tool DeepMemo`（原中央 CDS/Tantivy 检索），完整话题读取使用 `tool TopicMemo`。只读取这个工作区的会话；需要导入既有聊天时必须显式指定，初始化不会扫描你的 VCPChat AppData。

```powershell
vcp-memory session append --json '{"agent":"Agent","session":"main","messages":[{"role":"user","content":"记录今天的决策"}]}'
vcp-memory session get --json '{"agent":"Agent","session":"main"}'
vcp-memory context inspect --json '{"history":[]}'
```

## Agent 接入

项目自带 `.agents/skills/vcp-memory/SKILL.md`。Node API 的 `request(operation,payload,{home})` 每次启动隔离工作进程，避免上游单例污染其他工作区。高频任务可用 `vcp-memory serve` 的 JSONL 协议复用进程与缓存：

```json
{"id":1,"operation":"status","payload":{}}
{"id":2,"operation":"search","payload":{"query":"项目决策"},"diagnostics":true}
```

stdout 只向使用者输出 JSON，原生 Rust 日志及 JS 日志转入 stderr。关闭 stdin 后会排空任务并关闭进程资源。`backup` 保存可回退副本；更新包内快照后用 `runtime-upgrade` 先备份再升级运行源码。

## 验证与来源

新增[纯召回与存储实测报告](benchmarks/two-month-recall-v1/REPORT.md)：不调用DeepSeek，使用真实本地Embedding与原检索/存储链；记录571次召回、每题总时间与原阶段分数，以及1/10/100/720篇fresh写入。720篇从开始写到向量可查317.920秒（文件写完1.778秒），正常重启通过。路径评分后处理修正和CDS正文检索补充未通过均在报告披露。[CLI及CSV入口](benchmarks/two-month-recall-v1/README.md)可只读复查保存的原结果。

60天虚构双人交流的[完整系统主报告](benchmarks/two-month-system-v1/REPORT.md)以实际交付的最终答案为评价对象：142题中110题完整正确、11题部分正确、21题错误，完整正确率77.5%。本次主条件主动工具调用为0次，表现由自动记忆上下文供给主导；评分为代理交叉盲审，非人类评分。结果绑定报告登记的源码快照、模型与配置，不代表外部源目录后续版本。旧检索部件及固定阅读器实验仅作诊断附录，入口见 [评测导航](benchmarks/README.md)。

纯CLI复查最终答复与源诊断：

```powershell
node benchmarks/two-month-system-v1/inspect.cjs --query b1q07
node benchmarks/two-month-system-v1/inspect.cjs --query b1q07 --diagnostics
node benchmarks/two-month-system-v1/inspect.cjs --query b3q45 --arm rag-only
```

`rag-only`是“自动上下文，无主动工具”条件的CLI标识，`no-memory`是“仅近期上下文”。独立复跑先执行 `node benchmarks/two-month-system-v1/run.cjs --plan --results .\results-independent`；正式配置与执行要求见 [系统评测说明](benchmarks/two-month-system-v1/README.md)和[冻结协议](benchmarks/two-month-system-v1/PROTOCOL.md)。

```powershell
npm test
npm run verify:upstream
node scripts/verify-integrity.cjs
npm run test:upstream
npm run test:live
```

官网 Markdown 是从其公开应用 bundle 的静态字符串提取，记录 URL、时间与 SHA256 于 `references/official/manifest.json`。2026-11-02 页面摘要与嵌入白皮书版本不同，实际嵌入 V6；实现以包内已捕获源码快照为准。源许可证与署名保留，派生项目沿用 CC BY-NC-SA 4.0。请分别查看 ToolBox 与 Chat 原许可证。
