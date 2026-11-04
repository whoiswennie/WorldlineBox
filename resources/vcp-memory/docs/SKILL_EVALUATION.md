# Skill 与 CLI 前向验收

2026-11-02，在 Windows x64 / Node 22.19.0 中，按 `.agents/skills/vcp-memory/SKILL.md`、CLI `--help`、`catalog` 和 skill 引用的文档执行独立验收。全部数据存于本次新建的系统临时目录；没有读取真实用户日记、聊天或 API 密钥，结束后清除了临时 home。

## 任务结果

现实任务是保存项目决策 ADR-017、验证入库、召回决策、维护一个探索分支并回忆过去聊天。18步初次运行中，未初始化时的 `status`/`doctor` 两次按预期返回初始化指引，其余16步成功。完整 JSON、耗时、原工具结果和诊断尾部见 [skill-evaluation-evidence.json](./skill-evaluation-evidence.json)。

| 步骤 | 实际结果 |
|---|---|
| status / doctor / init / catalog | 初始化指引明确；原Rust模块ABI与快照校验通过 |
| tool DailyNote create | 保存“ADR-017选PostgreSQL为持久元数据，因重启持久性拒绝Redis”，附来源和标签 |
| sync | 原生存储完成入库回执验证，未把单纯文件写入当入库成功 |
| search --knn | 返回原始ADR-017内容和日记路径 |
| search（RiverMemo） | 返回ADR-017内容，带原RiverMemo拓扑信息 |
| session append | 创建过去讨论和当前迁移讨论，原始消息持久保存 |
| session fork / append / branch | 分支拥有冻结的父上下文和自己的回复，能读出完整合并消息 |
| session crystallize | 产出独立知识结晶文件和对话现场链接 |
| tool DeepMemo | 原中央Rust/Tantivy检索返回过去聊天中PostgreSQL与Redis取舍原文 |
| tool TopicMemo | 列出三个话题，并读取过去话题的完整两条消息 |

向量上游使用明确选择的 `tests/helpers/provider.cjs` 协议替身（64D）；原Rust索引、日记处理、RiverMemo、VCP-CDS和工具链实际运行。这里验证的是端到端数据流与协议，**不是对真实向量模型语义质量、真实付费摘要模型或多模态能力的替代验收**。

初次运行的 catalog/skill 没有公开 DeepMemo/TopicMemo，因此首次最后三步借助了源码审计已知的工具名，不能计为新agent自然发现。该卡点已修正：复测 catalog 含两个原工具manifest，skill已写明用途与可信上下文envelope。随后独立按新skill执行CLI，DeepMemo返回 `PAST_MARKER` 并排除当前话题的 `CURRENT_MARKER`，见 [skill-trusted-context-evidence.json](./skill-trusted-context-evidence.json)。

## 审阅发现与复测

本轮只审阅并复现 worker/client/workspace/CLI 协议问题，没有修改这些模块。实现修复由主代理处理；本报告区分初次发现和修复后的独立观察。

初次最小复现保存在 [skill-review-evidence.json](./skill-review-evidence.json)，针对修复的复测保存在 [skill-review-retest.json](./skill-review-retest.json)。其中秘密标记均为专门构造的 `EVAL_FAKE_*`，不是实际凭据。

| 问题 | 初次复现 | 最新独立复测 |
|---|---|---|
| serve自己的runtime锁阻断session操作 | 同一serve依次status、session.append，错误称本PID占用 | session.append通过 |
| serve自己的runtime锁阻断配置更新 | status后config.set失败 | config.set成功，随后status正常重新启动 |
| serve status后probe未启动向量层 | 按代码定位懒初始化路径缺少rag | probe返回有效64D向量 |
| 嵌套provider或headers配置回显凭据 | config set/get暴露fake apiKey/Authorization | 递归和header遮蔽通过，无fake-marker输出 |
| 默认空config覆盖环境endpoint | doctor认为env配置存在，probe却失败 | 仅env提供通用endpoint/key，probe成功 |
| 初始化失败后的恢复 | 无效协议按UNSUPPORTED_API返回，重复请求和config.set可恢复 | 未复现持锁死循环 |
| serve跨home污染 | 同一worker向另一个home请求status | 明确拒绝“A serve process is bound to one memory workspace” |
| DeepMemo当前话题上下文被CLI包装丢失 | 原tool包装没有保留外层context | 新CLI可信envelope实际排除current话题通过 |

`client.request` 每次使用独立worker；`createSession` 生成独立请求ID并在进程结束时拒绝未完成请求；JSONL stdout使用机器记录分隔标记，CLI只输出JSON，原生日志转stderr。上述前向运行均能解析stdout，没有把日志误当结果。不存在独立 `lib/protocol.cjs` 文件，协议实现位于 `lib/worker.cjs`、`lib/client.cjs`、`bin/vcp-memory.cjs`。

## 后续修复与检查点

1. **doctor的配置诊断已统一。** 现已按独立provider解析与本地模型配置判断；默认本地init后doctor实际返回已配置、768D与embeddinggemma-2，见 [skill-doctor-local-evidence.json](./skill-doctor-local-evidence.json)。该检查不启动真实推理，也不替代probe。
2. **死亡owner锁恢复实现已替换。** 原“判断PID死亡→rm旧锁→mkdir”的静态竞态已移除，当前由proper-lockfile维护10秒stale lease及更新。此次未另外实施真实kill进程后的多恢复者并发调度测试，不能把普通并发通过当作该故障注入场景已经实测。
3. **默认provider压缩接线已完成JSON工作进程复测。** 只配置工作区通用fixture端点，不提供payload.settings，session.auto-compact成功通过原provider router请求一次真实HTTP；之后只有checkpoint时不重复请求。纯压缩的temporary router诊断也包含真实HTTP耗时。附件内容经JSON session.prepare进入模型上下文。证据见 [context-cli-evaluation.json](./context-cli-evaluation.json)。这证明默认接线，不冒称真实付费模型验收。

本轮还在自己负责的 `lib/context.cjs` 找到混合多模态数组与单独附件消息会丢失附件extractedText的适配缺陷，已修复为按消息委托原版builder，并补上祖先图像、字符串附件与数组附件同时保留的回归测试。后续补入只读JSON附件宿主、原DOCX/PDF路径和85%自动压缩动作；`node --test tests/context.test.cjs` 最新16/16通过，原始VCPChat快照算法未修改。

验收范围不包含无密钥真实远端模型调用、真实模型召回质量评测、所有查询DSL排列组合、所有rerank/压缩/梦境/Magi路径，或旧用户数据大批量导入。相关范围应由独立功能矩阵和真实模型联调报告承担，不能因本任务主路径通过就称所有功能100%验收完成。
